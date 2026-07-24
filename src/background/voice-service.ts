import { isOutputExhausted } from '@kernel/sdk';
import {
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  VOICE_AUDIO_MAX_BYTES,
  VOICE_CREATE_TIMEOUT_MS,
  VOICE_RETRIEVAL_TIMEOUT_MS,
  VOICE_SCRIPT_TIMEOUT_MS,
} from '../shared/constants.js';
import {
  ChatGooseError,
  createUserError,
  isLiveUserErrorKey,
} from '../shared/errors.js';
import { resolveFeatureMessageCount } from '../shared/features.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { personaCatalogSource } from '../shared/persona-catalog.js';
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
import {
  VoiceAttemptCustodyMismatchError,
} from './voice-attempt-store.js';
import type { VoiceAttemptRepository } from './voice-attempt-store.js';

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
  sourceFingerprint: string;
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
  voiceAttempts: Pick<VoiceAttemptRepository, 'assertPendingCreate'>;
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

function structuredBodyErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const code = value.trim();
  // Only the shared registry is a stable wire-code allowlist. Reject HTTP
  // reason phrases such as "Internal Server Error" (and unknown ad-hoc
  // strings) so they cannot masquerade as machine-readable protocol codes.
  return isLiveUserErrorKey(code) ? code : null;
}

function structuredErrorCode(error: unknown, fallback: string): string {
  if (error instanceof ChatGooseError) {
    return error.key;
  }
  const body = errorBody(error);
  const bodyCode = structuredBodyErrorCode(body?.code) ??
    structuredBodyErrorCode(body?.error);
  if (bodyCode) {
    return bodyCode;
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const errorCode = error.code.trim();
    if (isLiveUserErrorKey(errorCode)) {
      return errorCode;
    }
  }
  return fallback;
}

function safeMessageForCode(code: string, fallback: Parameters<typeof createUserError>[0]): string {
  return createUserError(isLiveUserErrorKey(code) ? code : fallback).message;
}

function noteFailure(error: unknown): { code: string; message: string; status: number } {
  const body = errorBody(error);
  const status = isRecord(error)
    ? numericStatus(error.status) ||
      numericStatus(body?.statusCode) ||
      (isRecord(error.details) ? numericStatus(error.details.status) : 0)
    : 0;
  const structuredCode = structuredErrorCode(error, 'hub_request_failed');
  // A real kernel voice code is more specific than the transport status.
  // Only generic 401/403 bodies map to the credential guidance.
  const code = (status === 401 || status === 403) && structuredCode === 'hub_request_failed'
    ? 'hub_invalid_api_key'
    : structuredCode;
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
  if (!binding.fanAccountId || !context?.fanAccountId) {
    return 'fan_mismatch';
  }
  return context?.fanAccountId === binding.fanAccountId ? null : 'fan_mismatch';
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

interface TimedAbort {
  controller: AbortController;
  clear(): void;
  normalizeError(error: unknown): unknown;
}

function createTimedAbort(timeoutMs: number): TimedAbort {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    controller,
    clear: () => globalThis.clearTimeout(timeout),
    normalizeError: (error) => timedOut ? new ChatGooseError('timed_out') : error,
  };
}

function voiceTakeKey(attemptId: string, voiceNoteId: number): string {
  return `${attemptId}:${voiceNoteId}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

class VoiceArtifactValidationError extends Error {}

async function readBoundedAudioBytes(response: Response): Promise<ArrayBuffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isInteger(declared) || declared < 0 || declared > VOICE_AUDIO_MAX_BYTES) {
      throw new VoiceArtifactValidationError('invalid voice content length');
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new VoiceArtifactValidationError('voice response has no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (total + value.byteLength > VOICE_AUDIO_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new VoiceArtifactValidationError('voice response exceeds byte cap');
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function isMp3FrameHeader(bytes: Uint8Array, offset: number): boolean {
  if (offset + 3 >= bytes.byteLength) {
    return false;
  }
  const first = bytes[offset]!;
  const second = bytes[offset + 1]!;
  const third = bytes[offset + 2]!;
  const version = (second >> 3) & 0b11;
  const layer = (second >> 1) & 0b11;
  const bitrate = (third >> 4) & 0b1111;
  const sampleRate = (third >> 2) & 0b11;
  return first === 0xff &&
    (second & 0xe0) === 0xe0 &&
    version !== 0b01 &&
    layer === 0b01 &&
    bitrate !== 0 &&
    bitrate !== 0b1111 &&
    sampleRate !== 0b11;
}

/** Cheap worker-safe validation. Web Audio decoding is not available in a
 * Firefox MV3 background worker, so reject empty/text/corrupt payloads by
 * requiring a structurally valid MPEG audio frame after any ID3v2 tag. */
function isLikelyMp3(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  if (view.byteLength < 4) {
    return false;
  }
  let start = 0;
  if (
    view.byteLength >= 10 &&
    view[0] === 0x49 &&
    view[1] === 0x44 &&
    view[2] === 0x33
  ) {
    if ([view[6], view[7], view[8], view[9]].some((byte) => (byte! & 0x80) !== 0)) {
      return false;
    }
    const tagSize = (view[6]! << 21) |
      (view[7]! << 14) |
      (view[8]! << 7) |
      view[9]!;
    start = 10 + tagSize + ((view[5]! & 0x10) !== 0 ? 10 : 0);
    if (start >= view.byteLength) {
      return false;
    }
  }
  return isMp3FrameHeader(view, start);
}

/** Dedicated voice lane. It never enters OperationRegistry, acceptance
 * capture, generic result parsing, or the service_unavailable retry loop. */
export class VoiceService {
  private readonly portsByTabId = new Map<number, browser.runtime.Port>();
  private readonly activeScriptsByTabId = new Map<number, ActiveScript>();
  private readonly scriptAttemptIds = new Set<string>();
  private readonly attemptsByTakeKey = new Map<string, VoiceAttemptRecord>();
  /** Route/fan invalidation is permanent for this worker-lifetime take.
   * A successfully dispatched grant is not take-level invalidation: an
   * explicit human re-request may receive a fresh, independently single-use
   * token after an uncertain native handoff. */
  private readonly unavailableAttachTakeKeys = new Set<string>();
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
      if (message.type === 'tab:routeChanged') {
        this.invalidateRoute(tabId);
        return;
      }
      if (message.type === 'tab:init') {
        // Port reconnects replay tab:init for the same route. They must not burn
        // a paid take's still-valid in-memory attach attestation. A full content
        // reload may reset routeNonce, so rebind only when the account/group/fan
        // identity still matches; a different conversation is invalidated.
        this.rebindAttachAttemptsForTab(tabId);
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
    // A transient MV3 port loss is not a route change. Abort only the
    // non-replayable script stream; preserve paid-take attestation for the
    // reconnecting content controller.
    this.abortActiveScript(tabId);
  }

  handleTabRemoved(tabId: number): void {
    this.invalidateRoute(tabId);
    for (const [key, attempt] of this.attemptsByTakeKey) {
      if (attempt.binding.tabId === tabId) {
        this.attemptsByTakeKey.delete(key);
        this.unavailableAttachTakeKeys.delete(key);
        this.attachGrantsInFlight.delete(key);
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
    const isRegeneration = message.isRegeneration === true ||
      this.scriptAttemptIds.has(message.attemptId);
    this.scriptAttemptIds.add(message.attemptId);
    const clientRequestId = this.randomUUID();
    const deadline = createTimedAbort(VOICE_SCRIPT_TIMEOUT_MS);
    const { controller } = deadline;
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
      if (!fanAccountId) {
        throw new ChatGooseError('voice_source_invalid');
      }
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
      if (!sameRoute(routeBinding, this.deps.tabContexts.get(tabId))) {
        throw new ChatGooseError('chat_changed');
      }
      this.deps.tabContexts.setFan(
        tabId,
        routeBinding.groupId,
        fanAccountId,
        fanDisplayName,
      );

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
      let stopReason: string | null = null;
      const script = await this.deps.kernelGateway.streamFeature(
        state.settings,
        {
          feature: 'voice-script',
          clientRequestId,
          pageLabel: page.pageLabel,
          conversationRef: fanAccountId,
          fanRef: fanAccountId,
          replyTone: message.replyTone,
          draftText: message.draftText,
          isRegeneration,
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
          onStopReason: (reason) => {
            stopReason = reason;
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
      if (isOutputExhausted(stopReason) || !script.trim()) {
        throw new ChatGooseError('ai_output_unusable');
      }
      if (!generationRef) {
        throw new ChatGooseError('hub_request_failed');
      }
      const sourceFingerprint = personaCatalogSource(state.settings);
      if (!sourceFingerprint) {
        throw new ChatGooseError('hub_missing_api_key');
      }
      emit({
        type: 'voice:scriptComplete',
        attemptId: message.attemptId,
        script,
        generationRef,
        conversationRef: fanAccountId,
        sourceFingerprint,
        pageLabel: page.pageLabel,
      });
    } catch (error) {
      if (!this.isActiveScript(tabId, message.attemptId)) {
        return;
      }
      const normalizedError = deadline.normalizeError(error);
      if (isAbortError(normalizedError)) {
        return;
      }
      const code = structuredErrorCode(normalizedError, 'hub_request_failed');
      emit({
        type: 'voice:scriptError',
        attemptId: message.attemptId,
        code,
        message: safeMessageForCode(code, 'hub_request_failed'),
      });
    } finally {
      deadline.clear();
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
    const conversationRef = message.pinnedConversationRef.trim();
    // The free script step already resolved and persisted the canonical fan id.
    // Paid create accepts only that exact pin while the live route still agrees.
    if (
      !context ||
      !context.groupId ||
      !conversationRef ||
      message.conversationRef !== conversationRef
    ) {
      this.emitLocalNoteError(
        message.attemptId,
        { source: 'create' },
        'voice_source_invalid',
        emit,
      );
      return;
    }
    const routeBinding = bindingFromContext(context);
    const deadline = createTimedAbort(VOICE_CREATE_TIMEOUT_MS);
    const { controller } = deadline;
    try {
      let fanAccountId = context.fanAccountId;
      if (!fanAccountId) {
        const session = this.deps.sessionStore.getSessionForTab(tabId);
        if (!session?.connected) {
          throw new ChatGooseError('not_connected');
        }
        const [account, group] = await Promise.all([
          this.deps.fanslyClient.getAuthenticatedAccount(session, controller.signal),
          this.deps.fanslyClient.getGroup(context.groupId, session, controller.signal),
        ]);
        if (!sameRoute(routeBinding, this.deps.tabContexts.get(tabId))) {
          this.emitLocalNoteError(
            message.attemptId,
            { source: 'create' },
            'voice_source_invalid',
            emit,
          );
          return;
        }
        fanAccountId = (group.users ?? []).find(
          (user) => user.userId && user.userId !== account.id,
        )?.userId ?? null;
        if (!fanAccountId) {
          this.emitLocalNoteError(
            message.attemptId,
            { source: 'create' },
            'voice_source_invalid',
            emit,
          );
          return;
        }
        this.deps.tabContexts.setFan(
          tabId,
          routeBinding.groupId,
          fanAccountId,
          context.fanDisplayName,
        );
      }
      if (fanAccountId !== conversationRef) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      const liveContext = this.deps.tabContexts.get(tabId);
      if (
        !liveContext ||
        !sameRoute(routeBinding, liveContext) ||
        liveContext.fanAccountId !== conversationRef
      ) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      const binding = bindingFromContext(liveContext);
      const state = await this.deps.storageCoordinator.getState();
      const sourceFingerprint = personaCatalogSource(state.settings);
      if (!sourceFingerprint || sourceFingerprint !== message.sourceFingerprint) {
        throw new ChatGooseError('voice_source_invalid');
      }
      const page = await this.resolvePageForTab(tabId, controller.signal, state.settings);
      if (page.pageLabel !== message.pageLabel) {
        throw new ChatGooseError('voice_source_invalid');
      }
      if (attachRefusal(binding, this.deps.tabContexts.get(tabId)) !== null) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      if (!binding.accountId || !binding.groupId) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      // Paid boundary: Core is unreachable until the background repository
      // proves it still owns the exact acknowledged request. The repository
      // compares account+group but deliberately ignores the persisted nonce so
      // a tab reload can replay the same id; the live nonce/fan checks above
      // remain stricter and independent.
      await this.deps.voiceAttempts.assertPendingCreate({
        attemptId: message.attemptId,
        route: {
          accountId: binding.accountId,
          groupId: binding.groupId,
        },
        clientRequestId: message.clientRequestId,
        conversationRef: message.conversationRef,
        pinnedConversationRef: message.pinnedConversationRef,
        sourceGenerationRef: message.sourceGenerationRef,
        sourceFingerprint: message.sourceFingerprint,
        pageLabel: message.pageLabel,
        script: message.script,
        sentOnce: true,
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
      this.attemptsByTakeKey.set(voiceTakeKey(message.attemptId, view.voiceNoteId), {
        attemptId: message.attemptId,
        sourceFingerprint,
        pageLabel: page.pageLabel,
        voiceNoteId: view.voiceNoteId,
        binding,
      });
      emit({
        type: 'voice:noteView',
        attemptId: message.attemptId,
        clientRequestId: message.clientRequestId,
        view,
      });
    } catch (error) {
      if (error instanceof VoiceAttemptCustodyMismatchError) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      this.emitNoteError(
        message.attemptId,
        { source: 'create' },
        deadline.normalizeError(error),
        emit,
      );
    } finally {
      deadline.clear();
    }
  }

  private async readStatus(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:noteStatus' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    const deadline = createTimedAbort(VOICE_RETRIEVAL_TIMEOUT_MS);
    const { controller } = deadline;
    try {
      const state = await this.deps.storageCoordinator.getState();
      const pageLabel = await this.pageLabelForAttempt(
        tabId,
        message.attemptId,
        message.voiceNoteId,
        message.sourceFingerprint,
        message.pageLabel,
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
        deadline.normalizeError(error),
        emit,
      );
    } finally {
      deadline.clear();
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

    const deadline = createTimedAbort(VOICE_RETRIEVAL_TIMEOUT_MS);
    const { controller } = deadline;
    try {
      const state = await this.deps.storageCoordinator.getState();
      const pageLabel = await this.pageLabelForAttempt(
        tabId,
        message.attemptId,
        message.voiceNoteId,
        message.sourceFingerprint,
        message.pageLabel,
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
      const bytes = await readBoundedAudioBytes(response);
      if (
        !isLikelyMp3(bytes) ||
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
      if (error instanceof VoiceArtifactValidationError) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'audio', voiceNoteId: message.voiceNoteId },
          'voice_artifact_corrupt',
          emit,
        );
      } else {
        this.emitNoteError(
          message.attemptId,
          { source: 'audio', voiceNoteId: message.voiceNoteId },
          deadline.normalizeError(error),
          emit,
        );
      }
    } finally {
      deadline.clear();
    }
  }

  private async grantAttachToken(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:attachToken' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    const key = voiceTakeKey(message.attemptId, message.voiceNoteId);
    const attempt = this.attemptsByTakeKey.get(key);
    if (
      !attempt ||
      attempt.binding.tabId !== tabId ||
      this.unavailableAttachTakeKeys.has(key) ||
      this.attachGrantsInFlight.has(key)
    ) {
      this.emitAttachRefusal(message.attemptId, 'unknown', emit);
      return;
    }
    this.attachGrantsInFlight.add(key);
    try {
      const state = await this.deps.storageCoordinator.getState();
      if (
        message.sourceFingerprint !== attempt.sourceFingerprint ||
        message.pageLabel !== attempt.pageLabel ||
        personaCatalogSource(state.settings) !== attempt.sourceFingerprint
      ) {
        this.emitAttachRefusal(message.attemptId, 'unknown', emit);
        return;
      }
      const context = this.deps.tabContexts.get(tabId);
      const refusal = attachRefusal(attempt.binding, context);
      if (refusal) {
        this.unavailableAttachTakeKeys.add(key);
        this.emitAttachRefusal(message.attemptId, refusal, emit);
        return;
      }

      let fanUsername = context?.fanDisplayName?.trim() ?? '';
      if (!fanUsername && context?.fanAccountId) {
        const deadline = createTimedAbort(VOICE_RETRIEVAL_TIMEOUT_MS);
        try {
          const session = this.deps.sessionStore.getSessionForTab(tabId);
          if (session) {
            const [fan] = await this.deps.fanslyClient.getAccountNames(
              [context.fanAccountId],
              session,
              deadline.controller.signal,
              'none',
            );
            fanUsername = fan?.username?.trim() || fan?.displayName?.trim() || '';
          }
        } catch {
          // The attestation remains valid, but without a fan label it cannot be
          // safely handed to the DOM attach path.
        } finally {
          deadline.clear();
        }
      }
      const afterLookupRefusal = attachRefusal(
        attempt.binding,
        this.deps.tabContexts.get(tabId),
      );
      if (afterLookupRefusal) {
        this.unavailableAttachTakeKeys.add(key);
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
        voiceNoteId: message.voiceNoteId,
        token: this.randomUUID(),
        fanUsername,
      });
    } catch {
      this.emitAttachRefusal(message.attemptId, 'unknown', emit);
    } finally {
      this.attachGrantsInFlight.delete(key);
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
    sourceFingerprint: string,
    pageLabel: string,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<string> {
    if (
      !sourceFingerprint ||
      !pageLabel ||
      personaCatalogSource(settings) !== sourceFingerprint
    ) {
      throw new ChatGooseError('voice_source_invalid');
    }
    const attempt = this.attemptsByTakeKey.get(voiceTakeKey(attemptId, voiceNoteId));
    if (attempt) {
      if (
        attempt.binding.tabId !== tabId ||
        attempt.sourceFingerprint !== sourceFingerprint ||
        attempt.pageLabel !== pageLabel
      ) {
        throw new ChatGooseError('voice_source_invalid');
      }
    }
    // A worker restart may lose the in-memory attempt while the content-side V2
    // snapshot survives. Re-resolve the live page and require exact agreement
    // with that persisted source instead of silently retargeting the read.
    const livePage = await this.resolvePageForTab(tabId, signal, settings);
    if (livePage.pageLabel !== pageLabel) {
      throw new ChatGooseError('voice_source_invalid');
    }
    return pageLabel;
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
    for (const [key, attempt] of this.attemptsByTakeKey) {
      if (attempt.binding.tabId === tabId) {
        this.unavailableAttachTakeKeys.add(key);
      }
    }
  }

  private rebindAttachAttemptsForTab(tabId: number): void {
    const context = this.deps.tabContexts.get(tabId);
    if (!context) {
      return;
    }
    for (const [key, attempt] of this.attemptsByTakeKey) {
      if (attempt.binding.tabId !== tabId || this.unavailableAttachTakeKeys.has(key)) {
        continue;
      }
      if (
        attempt.binding.accountId === context.accountId &&
        attempt.binding.groupId === context.groupId &&
        attempt.binding.fanAccountId === context.fanAccountId
      ) {
        attempt.binding = bindingFromContext(context);
      } else {
        this.unavailableAttachTakeKeys.add(key);
      }
    }
  }
}
