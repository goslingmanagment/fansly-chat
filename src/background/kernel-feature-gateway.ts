// Stage 32 Task 3 — the kernel feature lane (the extension's only AI
// transport after the cutover; vendor clients die). One generation = one
// `POST /api/v1/ai/features/:feature` SSE stream via the vendored SDK.
//
// The extension keeps loading context itself (Fansly has no webhook lane —
// the kernel archive is pull-cadenced 30 min/24 h, while the panel reads the
// conversation live at generation time), so the request carries
// `clientContext` VALUES; prompt ASSEMBLY (templates, personas, platform
// wording, budgets, capture, ledger) is kernel-side.

import { KernelApiError, streamAiFeature, type AiGatewayStreamFrame } from '@kernel/sdk';
import { ChatGooseError } from '../shared/errors.js';
import { clientVersionHeaders } from '../shared/client-version.js';
import type { FeatureType, PingSegment, Settings } from '../shared/types.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { resolveHubBearer } from './agency-hub-client.js';

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
  personaKey?: string | null;
  replyTone?: 'none' | 'casual' | 'flirty' | 'upsell' | 'spicy';
  replyMode?: 'default' | 'preferSplit';
  draftText?: string;
  isRegeneration?: boolean;
  clientContext: KernelFeatureClientContext;
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
  onMeta?: (meta: { requestId: string; clientRequestId: string; model: string }) => void;
  onUsage?: (usage: KernelFeatureUsage) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (stopReason: string | null) => void;
}

/** Kernel product-gate wordings → the extension's CG error keys. Mapped
 * BEFORE the generic HTTP mapping so gate messages stay user-meaningful
 * (the desktop adapter's recorded pattern). */
function mapKernelGateError(error: KernelApiError): ChatGooseError | null {
  if (error.status !== 400) {
    return null;
  }
  const message = error.message;
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
      return new ChatGooseError('rate_limited', { message: error.message });
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

      const handleFrame = (frame: AiGatewayStreamFrame): void => {
        switch (frame.type) {
          case 'meta':
            callbacks.onMeta?.({
              requestId: frame.requestId,
              clientRequestId: frame.clientRequestId,
              model: frame.model,
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
            ...(request.personaKey != null ? { personaKey: request.personaKey } : {}),
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
          onFrame: handleFrame,
          signal,
        },
      );

      try {
        await handle.done;
      } catch (error) {
        throw toChatGooseError(error);
      }
      if (!done) {
        // Stream ended without the terminal frame — fail closed, never
        // present a possibly-truncated generation as complete.
        throw new ChatGooseError('hub_request_failed', {
          message: 'AI stream ended without completing.',
        });
      }
      return text;
    },
  };
}
