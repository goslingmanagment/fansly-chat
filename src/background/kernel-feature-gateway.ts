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
  pingSegment?: PingSegment;
}

export interface KernelFeatureRequest {
  feature: FeatureType;
  /** = operationId; the kernel dedup/correlation key. Must be a UUID. */
  clientRequestId: string;
  pageLabel: string;
  /** Fansly fan account id (conversation partner). */
  conversationRef: string;
  /** Explicit erasure/indexing identity; voice-script always supplies it. */
  fanRef?: string;
  personaKey?: string | null;
  /** Exact catalog definition expected to assemble the prompt. */
  expectedPersonaDefinitionId?: string;
  replyTone?: 'none' | 'casual' | 'flirty' | 'upsell' | 'spicy';
  replyMode?: 'default' | 'preferSplit';
  draftText?: string;
  isRegeneration?: boolean;
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

export interface KernelFeatureCallbacks {
  onText: (text: string) => void;
  /** Gateway meta frame: requestId = the generation ref (acceptance correlation). */
  onMeta?: (meta: {
    requestId: string;
    clientRequestId: string;
    model: string;
    personaDefinitionId?: string;
  }) => void;
  onUsage?: (usage: KernelFeatureUsage) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (stopReason: string | null) => void;
  /** Arrives right after meta, and only when the echo was requested AND the
   * kernel's window allows it. Silence means "not allowed", never an error. */
  onDebugInput?: (input: KernelFeatureDebugInput) => void;
}

/** Kernel product-gate structured codes (#120) → the extension's CG error
 * keys — matched on the error body's machine code, no message parsing. */
const KERNEL_GATE_KEYS: Record<string, 'not_enough_history' | 'hi_too_many_messages' | 'ping_blocked' | 'gate_voice_disabled' | 'unknown_error'> = {
  gate_min_messages: 'not_enough_history',
  gate_hi_greeting_limit: 'hi_too_many_messages',
  gate_ping_active: 'ping_blocked',
  gate_draft_required: 'unknown_error',
  gate_voice_disabled: 'gate_voice_disabled',
};

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
    const key = KERNEL_GATE_KEYS[error.code];
    if (key !== undefined) {
      return new ChatGooseError(key, { message });
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

function toChatGooseError(error: unknown): ChatGooseError {
  if (error instanceof ChatGooseError) {
    return error;
  }
  if (error instanceof KernelApiError) {
    const gate = mapKernelGateError(error);
    if (gate) {
      return gate;
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
          throw new ChatGooseError(
            frame.code.startsWith('provider') ? 'hub_provider_failed' : 'hub_request_failed',
            {
              details: { status: 0, responseSnippet: `${frame.code}: ${frame.message}` },
              ...(typeof frame.retryAfterMs === 'number'
                ? { retryAfterMs: frame.retryAfterMs }
                : {}),
            },
          );
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
            ...(request.fanRef !== undefined ? { fanRef: request.fanRef } : {}),
            ...(request.personaKey != null ? { personaKey: request.personaKey } : {}),
            ...(request.expectedPersonaDefinitionId !== undefined
              ? { expectedPersonaDefinitionId: request.expectedPersonaDefinitionId }
              : {}),
            ...(request.replyTone !== undefined ? { replyTone: request.replyTone } : {}),
            ...(request.replyMode !== undefined ? { replyMode: request.replyMode } : {}),
            ...(request.draftText !== undefined ? { draftText: request.draftText } : {}),
            isRegeneration: request.isRegeneration ?? false,
            clientContext: {
              transcript: request.clientContext.transcript,
              messageCount: request.clientContext.messageCount,
              fanDisplayName: request.clientContext.fanDisplayName,
              fanSpendingData: request.clientContext.fanSpendingData,
              fanSubscriptionData: request.clientContext.fanSubscriptionData,
              ...(request.clientContext.fanBio !== undefined
                ? { fanBio: request.clientContext.fanBio }
                : {}),
              ...(request.clientContext.pingSegment !== undefined
                ? { pingSegment: request.clientContext.pingSegment }
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
        const mapped = toChatGooseError(error);
        if (mapped.key === 'chat_changed') {
          refreshPersonaCatalog();
        }
        if (mapped.key === 'hub_quota_exceeded') {
          void recordQuotaDenied(request.pageLabel);
        }
        throw mapped;
      }
      if (!done) {
        // Stream ended without the terminal frame — fail closed, never
        // present a possibly-truncated generation as complete.
        throw new ChatGooseError('hub_request_failed', {
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
