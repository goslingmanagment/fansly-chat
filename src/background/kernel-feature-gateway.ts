// Stage 32 Task 3 — the kernel feature lane (the extension's only AI
// transport after the cutover; vendor clients die). One generation = one
// `POST /api/v1/ai/features/:feature` SSE stream via the vendored SDK.
//
// The extension keeps loading context itself (Fansly has no webhook lane —
// the kernel archive is pull-cadenced 30 min/24 h, while the panel reads the
// conversation live at generation time), so the request carries
// `clientContext` VALUES; prompt ASSEMBLY (templates, personas, platform
// wording, budgets, capture, ledger) is kernel-side.

import { KernelApiError, streamAiFeature, type AiFeatureStreamFrame } from '@kernel/sdk';
import { ChatGooseError } from '../shared/errors.js';
import { clientVersionHeaders } from '../shared/client-version.js';
import type { FeatureType, PingSegment, Settings } from '../shared/types.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { resolveHubBearer } from './agency-hub-client.js';
import { recordQuotaDenied, recordQuotaSnapshot } from './quota-tracker.js';

export interface KernelFeatureClientContext {
  transcript: string;
  messageCount: number;
  fanDisplayName: string;
  fanSpendingData: string;
  fanSubscriptionData: string;
  fanBio?: string;
  fanUsername?: string;
  fanAvatarUrl?: string;
  /** The chatter's saved name for the fan (Fansly rename, E115 / Core
   * Decision 290); read by the ping template. Absent when never renamed. */
  fanCustomName?: string;
  pingSegment?: PingSegment;
  /** Whole days since the fan's latest text, derived with the same clock as
   * `pingSegment`; ping only, bounded to Core's 0..20_000 contract (#127). */
  fanSilenceDays?: number;
  /** Coach + short-recap only (spec §5/§6): whether the shipped transcript is
   * the fan's whole history or a bounded window. Kernel-bound only — it never
   * rides the content→background protocol. */
  transcriptCoverage?: 'full-history' | 'window';
}

/** One replayed coach exchange (oldest-first), already char-projected client
 * side. Mirrors the SDK body's `coachHistory[]` strict shape. */
export interface KernelCoachHistoryEntry {
  question: string;
  answer: string;
}

export interface KernelFeatureRequest {
  feature: FeatureType;
  /** = operationId; the kernel dedup/correlation key. Must be a UUID. */
  clientRequestId: string;
  pageLabel: string;
  /** Fansly fan account id (conversation partner) OR — for coach + recap —
   * the canonical Fansly group id (spec §5). */
  conversationRef: string;
  /** Canonical fan identity, separate from `conversationRef` (spec §5). Sent
   * for coach-chat and voice-script (REQUIRED there) and fan-summary once the
   * fan is resolved. */
  fanRef?: string | null;
  personaKey?: string | null;
  /** Exact catalog definition expected to assemble the prompt. */
  expectedPersonaDefinitionId?: string;
  replyTone?: 'none' | 'casual' | 'flirty' | 'upsell' | 'spicy';
  replyMode?: 'default' | 'preferSplit';
  draftText?: string;
  isRegeneration?: boolean;
  /** coach-chat: the chatter's live question for this turn (kernel requires it
   * for coach-chat, rejects it elsewhere). */
  chatterQuestion?: string;
  /** coach-chat: kernel-owned canned question, per Core Decision #204. */
  preset?: 'situation';
  /** coach-chat: prior completed exchanges replayed as dialog memory. */
  coachHistory?: KernelCoachHistoryEntry[];
  /** fan-summary: sent ONLY as 'short' (a full run omits it — an old kernel
   * then never sees the field, keeping rollback safe). */
  summaryMode?: 'short';
  greetingMode?: 'new-follower';
  /** The REQUESTED transcript window (deepMessageCount for a full recap, the
   * short const for a short recap, the quick window otherwise) — distinct from
   * `clientContext.messageCount` (the KEPT count). The kernel records it as the
   * recap's `requestedCount`; without it core falls back to its own default and
   * recap-status mode matching breaks (a full recap at 3000 recorded as 1500). */
  messageCount?: number;
  clientContext: KernelFeatureClientContext;
  /** Debug mode only (E28): ask the kernel to echo the prompt it assembled.
   * Rides a capability HEADER, never the request body — an old kernel ignores
   * it, so a kernel rollback can never break a generation from a new client.
   * The kernel still answers only inside an owner-set, time-bounded window. */
  debugPromptEcho?: boolean;
}

/** The kernel's `debug_input_v1` echo: the EXACT blocks it sent to the model. */
export interface KernelFeatureDebugInput {
  systemBlocks: Array<{ text: string; cache: string }>;
  userBlocks: Array<{ text: string; cache: string }>;
  contextManifest: Record<string, unknown> | null;
}

export interface KernelFeatureUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Gateway-priced (Stage 29) — the only spend source post-cutover. */
  costMicroUsd: number;
  costApproximate: boolean;
}

/** Coach-only provenance for the recap bodies Core actually retained in the
 * finalized prompt. This may differ from the earlier recap-status read. */
export interface KernelFeatureAttachedRecaps {
  full: { generatedAt: string; ageMs: number } | null;
  short: { generatedAt: string; ageMs: number } | null;
}

export interface KernelFeatureCallbacks {
  onText: (text: string) => void;
  /** Gateway meta frame: requestId = the generation ref (acceptance correlation). */
  onMeta?: (meta: {
    requestId: string;
    clientRequestId: string;
    model: string;
    personaDefinitionId?: string;
    attachedRecaps?: KernelFeatureAttachedRecaps;
    presetQuestion?: string;
  }) => void;
  onUsage?: (usage: KernelFeatureUsage) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (stopReason: string | null) => void;
  /** Arrives right after meta, and only when the echo was requested AND the
   * kernel's window allows it. Silence means "not allowed", never an error. */
  onDebugInput?: (input: KernelFeatureDebugInput) => void;
}

/** Known kernel provider failures are exact-matched before the family-safe
 * `provider*` fallback. Provider/proxy stream failures keep E38's CG-HUB-10
 * card; newly classified causes get their own chatter-facing cards. */
function kernelErrorFrameOptions(
  frame: Extract<AiFeatureStreamFrame, { type: 'error' }>,
) {
  const retryAfterMs = typeof frame.retryAfterMs === 'number'
    ? frame.retryAfterMs
    : undefined;
  return {
    details: { status: 0, responseSnippet: `${frame.code}: ${frame.message}` },
    ...(retryAfterMs !== undefined
      ? {
          retryAfterMs,
          retryAtMs: Date.now() + retryAfterMs,
        }
      : {}),
  };
}

function createKernelErrorFrameError(
  frame: Extract<AiFeatureStreamFrame, { type: 'error' }>,
): ChatGooseError {
  // Completed-but-empty output belongs to the existing output guard, not the
  // provider-infrastructure family.
  if (frame.code === 'provider_output_empty') {
    return new ChatGooseError('ai_output_unusable', kernelErrorFrameOptions(frame));
  }

  switch (frame.code) {
    case 'provider_billing':
      return new ChatGooseError('hub_provider_billing', kernelErrorFrameOptions(frame));
    case 'provider_auth':
      return new ChatGooseError('hub_provider_auth', kernelErrorFrameOptions(frame));
    case 'provider_rate_limited':
      return new ChatGooseError('hub_provider_rate_limited', kernelErrorFrameOptions(frame));
    case 'provider_unavailable':
      return new ChatGooseError('hub_provider_unavailable', kernelErrorFrameOptions(frame));
    case 'provider_proxy_unreachable':
    case 'provider_stream_failed':
      return new ChatGooseError('hub_provider_failed', kernelErrorFrameOptions(frame));
  }

  // Open-string rollback safety: future provider codes remain actionable as
  // the established generic provider card until this client learns them.
  if (frame.code.startsWith('provider')) {
    return new ChatGooseError('hub_provider_failed', kernelErrorFrameOptions(frame));
  }
  return new ChatGooseError('hub_request_failed', kernelErrorFrameOptions(frame));
}

/** Kernel product-gate denials → the extension's CG error keys. Mapped
 * BEFORE the generic HTTP mapping so gate messages stay user-meaningful
 * (the desktop adapter's recorded pattern). Structured code first; the
 * wording match stays as a fallback for pre-#120 kernels. */
function mapKernelGateError(error: KernelApiError): ChatGooseError | null {
  if (error.status !== 400) {
    return null;
  }
  const message = error.message;
  if (error.code !== null) {
    switch (error.code) {
      case 'gate_min_messages':
        return new ChatGooseError('not_enough_history', { message });
      case 'gate_hi_greeting_limit':
        return new ChatGooseError('hi_too_many_messages', { message });
      case 'gate_ping_active':
        return new ChatGooseError('ping_blocked', { message });
      case 'gate_draft_required':
        return new ChatGooseError('unknown_error', { message });
      case 'gate_voice_disabled':
        return new ChatGooseError('gate_voice_disabled', { message });
    }
  }
  if (message.includes('requires at least')) {
    return new ChatGooseError('not_enough_history', { message });
  }
  if (message.includes('at most') && message.includes('hi-greeting')) {
    return new ChatGooseError('hi_too_many_messages', { message });
  }
  if (message.includes('blocked while the conversation is active')) {
    return new ChatGooseError('ping_blocked', { message });
  }
  return null;
}

/** A pre-Coach Hub rejects the new strict body before feature dispatch, so it
 * returns Fastify's generic 400 rather than the newer structured 404. Match
 * only that additional-key validation shape; current-Hub Coach 400s retain
 * their real error instead of being mislabeled as a version gap. */
function isLegacyCoachBodyValidation(error: KernelApiError): boolean {
  return error.status === 400 &&
    error.code === 'Bad Request' &&
    /(?:unrecognized key|additional propert)/i.test(error.message) &&
    /\b(?:chatterQuestion|coachHistory|transcriptCoverage)\b/.test(error.message);
}

function toChatGooseError(error: unknown, feature?: FeatureType): ChatGooseError {
  if (error instanceof ChatGooseError) {
    return error;
  }
  if (error instanceof KernelApiError) {
    const gate = mapKernelGateError(error);
    if (gate) {
      return gate;
    }
    if (feature === 'coach-chat' && isLegacyCoachBodyValidation(error)) {
      return new ChatGooseError('coach_requires_newer_hub', { message: error.message });
    }
    // Structured `unknown_ai_feature` (404): this page's Hub predates the
    // feature (coach-chat). Only the STRUCTURED code maps to the actionable
    // "newer Hub" card — a bare 404 (missing/unauthorized page) must keep its
    // generic handling below, never be mislabelled as a version gap.
    if (error.status === 404 && error.code === 'unknown_ai_feature') {
      return new ChatGooseError('coach_requires_newer_hub', { message: error.message });
    }
    if (error.status === 429) {
      // The AI gateway's daily-cap denial ships code "quota_denied" (its
      // gateway_outcome ledger value) — a day-scoped budget, not a transient
      // rate limit, so it gets its own card instead of "try again shortly".
      return error.code === 'quota_denied'
        ? new ChatGooseError('hub_quota_exceeded', { message: error.message })
        : new ChatGooseError('rate_limited', { message: error.message });
    }
    if (error.status === 409 && error.code === 'persona_definition_changed') {
      return new ChatGooseError('chat_changed', { message: error.message });
    }
    if (error.status === 503 || error.status === 502) {
      return new ChatGooseError('service_unavailable', { message: error.message });
    }
    if (error.status === 401 || error.status === 403) {
      return new ChatGooseError('hub_invalid_api_key', {
        details: { status: error.status, responseSnippet: error.message.slice(0, 400) },
      });
    }
    if (error.category === 'network' && error.code === 'aborted') {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    return new ChatGooseError('hub_request_failed', {
      details: { status: error.status ?? 0, responseSnippet: error.message.slice(0, 400) },
    });
  }
  return new ChatGooseError('hub_request_failed', {
    details: {
      status: 0,
      responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
    },
  });
}

export interface KernelFeatureGateway {
  isConfigured(settings: Settings): boolean;
  /** Streams one generation; resolves with the full raw text. */
  streamFeature(
    settings: Settings,
    request: KernelFeatureRequest,
    callbacks: KernelFeatureCallbacks,
    signal: AbortSignal,
  ): Promise<string>;
}

export function createKernelFeatureGateway(
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  onPersonaDefinitionChanged: () => void | Promise<void> = () => {},
): KernelFeatureGateway {
  return {
    isConfigured(settings) {
      return Boolean(
        normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl) && resolveHubBearer(settings),
      );
    },

    async streamFeature(settings, request, callbacks, signal) {
      const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
      const bearer = resolveHubBearer(settings);
      if (!baseUrl || !bearer) {
        throw new ChatGooseError('hub_missing_api_key');
      }

      let text = '';
      let done = false;
      let personaDefinitionValidated = request.expectedPersonaDefinitionId === undefined;
      // The vendored SDK swallows EVERY exception once its signal is aborted
      // (`sdk-runtime.js`: `.catch((error) => { if (abort.signal.aborted) { return; } throw error; })`),
      // so an abort racing the teardown would EAT the kernel's own terminal
      // error frame and leave the classification below guessing from
      // `done === false`. Capture the mapped frame error here so that verdict
      // can outrank both the abort and the truncation ones.
      let terminalFrameError: ChatGooseError | null = null;

      const refreshPersonaCatalog = (): void => {
        try {
          void Promise.resolve(onPersonaDefinitionChanged()).catch(() => undefined);
        } catch {
          // The generation remains fail-closed even if refresh scheduling fails.
        }
      };

      const handleFrame = (frame: AiFeatureStreamFrame): void => {
        // A terminal error frame is the kernel NAMING the failure (e.g. a
        // dead page proxy → provider_stream_failed). It must surface as that
        // cause — before the provenance barrier, which would misreport it as
        // chat_changed, and before EOF collapses it into the generic
        // "ended without completing" truncation error.
        if (frame.type === 'error') {
          terminalFrameError = createKernelErrorFrameError(frame);
          throw terminalFrameError;
        }
        // The meta echo is the provenance barrier for the whole stream, not
        // only visible content. Debug/reasoning/usage/done callbacks can all
        // mutate UI or accounting state, so none may escape before the exact
        // server-applied definition has been confirmed.
        if (frame.type !== 'meta' && !personaDefinitionValidated) {
          throw new ChatGooseError('chat_changed');
        }
        switch (frame.type) {
          case 'debug_input_v1':
            callbacks.onDebugInput?.({
              systemBlocks: frame.systemBlocks,
              userBlocks: frame.userBlocks,
              contextManifest: frame.contextManifest,
            });
            return;
          case 'meta':
            if (
              request.expectedPersonaDefinitionId !== undefined &&
              frame.personaDefinitionId !== request.expectedPersonaDefinitionId
            ) {
              throw new ChatGooseError('chat_changed');
            }
            personaDefinitionValidated = true;
            // The meta frame's quota snapshot feeds the popup indicator —
            // fire-and-forget so a storage hiccup can't stall the stream.
            void recordQuotaSnapshot(
              frame.pageLabel,
              frame.quota.remainingRequestsToday,
            );
            callbacks.onMeta?.({
              requestId: frame.requestId,
              clientRequestId: frame.clientRequestId,
              model: frame.model,
              ...(frame.personaDefinitionId !== undefined
                ? { personaDefinitionId: frame.personaDefinitionId }
                : {}),
              ...(frame.attachedRecaps !== undefined
                ? { attachedRecaps: frame.attachedRecaps }
                : {}),
              ...(frame.presetQuestion !== undefined
                ? { presetQuestion: frame.presetQuestion }
                : {}),
            });
            return;
          case 'content_delta':
            text += frame.text;
            callbacks.onText(frame.text);
            return;
          case 'reasoning_delta':
            callbacks.onReasoningDelta?.(frame.text);
            return;
          case 'usage':
            callbacks.onUsage?.({
              inputTokens: frame.usage.inputTokens,
              outputTokens: frame.usage.outputTokens,
              cacheWriteTokens: frame.usage.cacheWriteTokens,
              cacheReadTokens: frame.usage.cacheReadTokens,
              costMicroUsd: frame.usage.costMicroUsd,
              costApproximate: frame.usage.costApproximate,
            });
            return;
          case 'done':
            done = true;
            callbacks.onStopReason?.(frame.stopReason ?? null);
            return;
          default:
            return;
        }
      };

      const handle = streamAiFeature(
        {
          baseUrl,
          auth: { mode: 'bearer', token: () => bearer },
          headers: clientVersionHeaders(),
          fetch: fetchImpl,
        },
        {
          feature: request.feature,
          body: {
            clientRequestId: request.clientRequestId,
            pageLabel: request.pageLabel,
            platform: 'fansly',
            conversationRef: request.conversationRef,
            ...(request.fanRef != null ? { fanRef: request.fanRef } : {}),
            ...(request.personaKey != null ? { personaKey: request.personaKey } : {}),
            ...(request.expectedPersonaDefinitionId !== undefined
              ? { expectedPersonaDefinitionId: request.expectedPersonaDefinitionId }
              : {}),
            ...(request.replyTone !== undefined ? { replyTone: request.replyTone } : {}),
            ...(request.replyMode !== undefined ? { replyMode: request.replyMode } : {}),
            ...(request.draftText !== undefined ? { draftText: request.draftText } : {}),
            ...(request.chatterQuestion !== undefined
              ? { chatterQuestion: request.chatterQuestion }
              : {}),
            ...(request.preset !== undefined ? { preset: request.preset } : {}),
            ...(request.coachHistory !== undefined
              ? { coachHistory: request.coachHistory }
              : {}),
            // Only ever 'short'; a full recap omits the field entirely so an old
            // kernel (which never learned it) still runs a legacy full summary.
            ...(request.summaryMode === 'short' ? { summaryMode: 'short' } : {}),
            ...(request.greetingMode ? { greetingMode: request.greetingMode } : {}),
            // Top-level REQUESTED window (kernel records it as requestedCount);
            // clientContext.messageCount below is the KEPT count.
            ...(request.messageCount !== undefined
              ? { messageCount: request.messageCount }
              : {}),
            isRegeneration: request.isRegeneration ?? false,
            clientContext: {
              transcript: request.clientContext.transcript,
              messageCount: request.clientContext.messageCount,
              fanDisplayName: request.clientContext.fanDisplayName,
              ...(request.clientContext.fanUsername !== undefined ? { fanUsername: request.clientContext.fanUsername } : {}),
              ...(request.clientContext.fanAvatarUrl ? { fanAvatarUrl: request.clientContext.fanAvatarUrl } : {}),
              fanSpendingData: request.clientContext.fanSpendingData,
              fanSubscriptionData: request.clientContext.fanSubscriptionData,
              ...(request.clientContext.fanBio !== undefined
                ? { fanBio: request.clientContext.fanBio }
                : {}),
              ...(request.clientContext.fanCustomName !== undefined
                ? { fanCustomName: request.clientContext.fanCustomName }
                : {}),
              ...(request.clientContext.pingSegment !== undefined
                ? { pingSegment: request.clientContext.pingSegment }
                : {}),
              ...(request.clientContext.fanSilenceDays !== undefined
                ? { fanSilenceDays: request.clientContext.fanSilenceDays }
                : {}),
              ...(request.clientContext.transcriptCoverage !== undefined
                ? { transcriptCoverage: request.clientContext.transcriptCoverage }
                : {}),
            },
          },
          ...(request.debugPromptEcho ? { debugPromptEcho: true } : {}),
          onFrame: handleFrame,
          signal,
        },
      );

      try {
        await handle.done;
      } catch (error) {
        const mapped = toChatGooseError(error, request.feature);
        if (mapped.key === 'chat_changed') {
          refreshPersonaCatalog();
        }
        if (mapped.key === 'hub_quota_exceeded') {
          void recordQuotaDenied(request.pageLabel);
        }
        throw mapped;
      }
      // `handle.done` RESOLVED — which, thanks to the SDK's abort-swallow,
      // also happens for an aborted stream and for a frame error thrown while
      // the signal was already aborted. Classify in this exact order.
      if (terminalFrameError !== null) {
        // The kernel spoke: its terminal error frame outranks both the abort
        // and the truncation verdicts — the SDK's abort-swallow must not eat
        // it. The frame error is already mapped by `createKernelErrorFrameError`
        // (which never mints chat_changed or hub_quota_exceeded), so throwing
        // it here is equivalent to the rejection path's mapping above.
        throw terminalFrameError;
      }
      if (!done) {
        if (signal.aborted) {
          // The vendored SDK swallows aborts, so an aborted stream arrives
          // here as a resolved handle with no terminal frame. Re-raise as
          // AbortError so operation-utils maps it honestly (timed_out for an
          // armed timeout, chat_changed for a user cancel) — a local timeout
          // is NOT a truncated stream and NOT a Hub error, and must not grow
          // the daily "Ошибки генераций (Hub)" CG-HUB-* counter.
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        // Stream ended without the terminal frame — fail closed, never
        // present a possibly-truncated generation as complete.
        throw new ChatGooseError('hub_stream_truncated', {
          message: 'AI stream ended without completing.',
        });
      }
      if (!personaDefinitionValidated) {
        refreshPersonaCatalog();
        throw new ChatGooseError('chat_changed');
      }
      return text;
    },
  };
}
