import { MAX_TOKENS, OPENROUTER_MESSAGES_API_URL } from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import {
  getOpenRouterGeminiThinkingMaxTokens,
  isOpenRouterGeminiModel,
  supportsOpenRouterGeminiThinking,
} from '../shared/model-capabilities.js';
import type {
  LlmUsageMetrics,
  FeatureType,
  LlmReasoningSignal,
  PromptTextBlock,
  ReasoningEffort,
} from '../shared/types.js';
import {
  extractReasoningDeltaText,
  mergeUsage,
  parseRetryAfterMs,
  parseSseBlock,
  usageEquals,
} from './llm-stream-utils.js';

interface OpenRouterStreamArgs {
  apiKey: string;
  model: string;
  temperature: number;
  systemBlocks: PromptTextBlock[];
  userBlocks: PromptTextBlock[];
  feature: FeatureType;
  reasoningEffort: ReasoningEffort;
  signal: AbortSignal;
  onText: (text: string) => void;
  onUsage?: (usage: LlmUsageMetrics) => void;
  onProgress?: () => void;
  onReasoningObserved?: (signal: LlmReasoningSignal) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (stopReason: string | null) => void;
}

interface OpenRouterApiErrorBody {
  error?: {
    code?: number | string;
    type?: string;
    message?: string;
  };
}

interface OpenRouterApiErrorInfo {
  code?: number | string;
  type?: string;
  message?: string;
}

const SUPPORTED_OPENROUTER_SSE_EVENTS = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'ping',
  'error',
]);

type OpenRouterUsagePayload = Partial<LlmUsageMetrics> & {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

type OpenRouterThinkingEffort = Exclude<ReasoningEffort, 'off' | 'max'>;

function resolveMaxTokens(model: string, feature: FeatureType): number {
  if (isOpenRouterGeminiModel(model)) {
    return getOpenRouterGeminiThinkingMaxTokens(feature) ?? MAX_TOKENS[feature];
  }
  return MAX_TOKENS[feature];
}

function buildGeminiThinkingConfig(
  model: string,
  feature: FeatureType,
  reasoningEffort: ReasoningEffort,
): {
  thinking?: { type: 'adaptive'; display: 'omitted' };
  output_config?: { effort: OpenRouterThinkingEffort };
} {
  if (!supportsOpenRouterGeminiThinking(model, feature) || reasoningEffort === 'off') {
    return {};
  }

  const effort: OpenRouterThinkingEffort = reasoningEffort === 'max' ? 'high' : reasoningEffort;
  return {
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort },
  };
}

function detectReasoningSignal(payload: {
  content_block?: { type?: string };
  delta?: { type?: string; reasoning?: unknown };
  reasoning?: unknown;
  choices?: unknown[];
}): LlmReasoningSignal | null {
  switch (payload.content_block?.type) {
    case 'thinking':
      return 'thinking_block';
    case 'redacted_thinking':
      return 'redacted_thinking_block';
  }

  switch (payload.delta?.type) {
    case 'thinking_delta':
      return 'thinking_delta';
    case 'signature_delta':
      return 'signature_delta';
  }

  if (hasReasoningProperty(payload.delta) || hasReasoningProperty(payload)) {
    return 'reasoning_delta';
  }

  const hasChoiceReasoning = payload.choices?.some((choice) =>
    hasReasoningProperty((choice as { delta?: unknown }).delta) ||
    hasReasoningProperty((choice as { message?: unknown }).message),
  );
  return hasChoiceReasoning ? 'reasoning_delta' : null;
}

function hasReasoningProperty(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'reasoning')
  );
}

function stripCacheControl(blocks: PromptTextBlock[]): PromptTextBlock[] {
  // OpenRouter Grok prompt caching is automatic, so cache_control is not needed.
  // Gemini requires explicit breakpoints, but this app currently marks Gemini as
  // supportsPromptCache=false and does not build Gemini cache breakpoints. Enabling
  // Gemini explicit caching needs registry, prompt builder, and adapter changes.
  return blocks.map((block) => ({
    type: block.type,
    text: block.text,
  }));
}

function normalizeUsage(
  usage: OpenRouterUsagePayload | null | undefined,
): Partial<LlmUsageMetrics> | undefined {
  if (!usage) {
    return undefined;
  }

  const normalized: Partial<LlmUsageMetrics> = {};
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : usage.completion_tokens;

  if (typeof usage.input_tokens !== 'number' && typeof usage.prompt_tokens === 'number') {
    const promptDetails = usage.prompt_tokens_details;
    const cacheReadTokens =
      typeof promptDetails?.cached_tokens === 'number'
        ? promptDetails.cached_tokens
        : 0;
    const cacheWriteTokens =
      typeof promptDetails?.cache_write_tokens === 'number'
        ? promptDetails.cache_write_tokens
        : 0;

    normalized.input_tokens = Math.max(
      0,
      usage.prompt_tokens - cacheReadTokens - cacheWriteTokens,
    );
    normalized.cache_creation_input_tokens = Math.max(0, cacheWriteTokens);
    normalized.cache_read_input_tokens = Math.max(0, cacheReadTokens);
  } else {
    if (typeof usage.input_tokens === 'number') {
      normalized.input_tokens = usage.input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === 'number') {
      normalized.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }
    if (typeof usage.cache_read_input_tokens === 'number') {
      normalized.cache_read_input_tokens = usage.cache_read_input_tokens;
    }
    if (usage.cache_creation) {
      normalized.cache_creation = usage.cache_creation;
    }
  }

  if (typeof outputTokens === 'number') {
    normalized.output_tokens = outputTokens;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getHeader(response: Response, name: string): string | null {
  if (!response.headers || typeof response.headers.get !== 'function') {
    return null;
  }
  return response.headers.get(name);
}

async function readOpenRouterError(response: Response): Promise<OpenRouterApiErrorInfo | null> {
  if (typeof response.json !== 'function') {
    return null;
  }

  try {
    const body = await response.json() as OpenRouterApiErrorBody;
    return body.error
      ? {
          code: body.error.code,
          type: body.error.type,
          message: body.error.message,
        }
      : null;
  } catch {
    return null;
  }
}

function matchesMessage(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

function buildOpenRouterError(
  status: number,
  info: OpenRouterApiErrorInfo | null,
  retryAfterMs?: number,
): ChatGooseError {
  const type = info?.type?.toString().trim().toLowerCase() ?? '';
  const code = info?.code?.toString().trim().toLowerCase() ?? '';
  const message = info?.message?.trim() ?? '';
  const normalizedMessage = message.toLowerCase();
  const details = {
    provider: 'openrouter',
    ...(status > 0 ? { status } : {}),
    ...(message ? { providerMessage: message } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAtMs: Date.now() + retryAfterMs } : {}),
  };

  if (status === 429 || code === '429' || normalizedMessage.includes('rate limit')) {
    return new ChatGooseError('rate_limited', {
      details,
      retryAfterMs,
      retryAtMs: details.retryAtMs,
    });
  }

  if (
    status === 402 ||
    code === '402' ||
    // Bare 'billing' is excluded — it over-matches; real payment errors are a
    // 402 status/code or one of the specific phrases below.
    matchesMessage(normalizedMessage, [
      'insufficient credits',
      'insufficient balance',
      'payment required',
    ])
  ) {
    return new ChatGooseError('insufficient_balance', { details });
  }

  if (status === 401 || status === 403 || code === '401' || code === '403') {
    return new ChatGooseError('invalid_api_key', { details });
  }

  if (
    status === 404 ||
    type === 'not_found_error' ||
    // Bare 'not found' is excluded — it over-matches and would wrongly trigger
    // the model-fallback retry; unknown models surface as a 404 or one of the
    // model-specific phrases below.
    matchesMessage(normalizedMessage, [
      'model not found',
      'invalid model',
      'not a valid model',
      'does not exist',
      'is unavailable',
    ])
  ) {
    return new ChatGooseError('model_unavailable', { details });
  }

  if (
    status === 413 ||
    matchesMessage(normalizedMessage, [
      'context length',
      'maximum context',
      'too many tokens',
      'prompt is too long',
      'request is too large',
    ])
  ) {
    return new ChatGooseError('context_too_long', { details });
  }

  if (status === 502 || status === 503 || status >= 500) {
    return new ChatGooseError('service_unavailable', { details });
  }

  if (status === 400) {
    return new ChatGooseError('unknown_error', { details });
  }

  if (status === 0) {
    return new ChatGooseError('service_unavailable', { details });
  }

  return new ChatGooseError('network_error', { details });
}

export class OpenRouterClient {
  async streamMessage({
    apiKey,
    model,
    temperature,
    systemBlocks,
    userBlocks,
    feature,
    reasoningEffort,
    signal,
    onText,
    onUsage,
    onProgress,
    onReasoningObserved,
    onReasoningDelta,
    onStopReason,
  }: OpenRouterStreamArgs): Promise<string> {
    let rawText = '';
    let usage: LlmUsageMetrics | null = null;
    const response = await fetch(OPENROUTER_MESSAGES_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-openrouter-title': 'ChatGoose',
      },
      signal,
      body: JSON.stringify({
        model,
        temperature,
        stream: true,
        max_tokens: resolveMaxTokens(model, feature),
        ...buildGeminiThinkingConfig(model, feature, reasoningEffort),
        system: stripCacheControl(systemBlocks),
        messages: [{ role: 'user', content: stripCacheControl(userBlocks) }],
      }),
    });

    if (!response.ok) {
      const errorInfo = await readOpenRouterError(response);
      const retryAfterMs = parseRetryAfterMs(getHeader(response, 'retry-after'));
      throw buildOpenRouterError(response.status, errorInfo, retryAfterMs);
    }

    if (!response.body) {
      throw new ChatGooseError('network_error', {
        details: { provider: 'openrouter' },
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        // Split on blank-line event boundaries, tolerating CRLF (\r\n\r\n)
        // from intermediary proxies as well as LF-only separators.
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed || parsed.data === '[DONE]') {
            continue;
          }

          let payload: {
            type?: string;
            object?: string;
            choices?: unknown[];
            message?: { usage?: OpenRouterUsagePayload };
            content_block?: { type?: string };
            usage?: OpenRouterUsagePayload;
            delta?: {
              type?: string;
              thinking?: unknown;
              text?: string;
              stop_reason?: string | null;
              reasoning?: unknown;
            };
            reasoning?: unknown;
            error?: { type?: string; message?: string; code?: number | string };
          };
          try {
            payload = JSON.parse(parsed.data) as typeof payload;
          } catch {
            continue;
          }

          onProgress?.();

          if (parsed.event === 'error' || payload.type === 'error' || payload.error) {
            throw buildOpenRouterError(0, payload.error ?? null);
          }

          const effectiveEvent =
            parsed.event === 'message' && typeof payload.type === 'string'
              ? payload.type
              : parsed.event;

          if (!SUPPORTED_OPENROUTER_SSE_EVENTS.has(effectiveEvent)) {
            if (payload.object === 'chat.completion.chunk' || Array.isArray(payload.choices)) {
              throw new ChatGooseError('unknown_error', {
                details: {
                  provider: 'openrouter',
                  providerMessage: 'Unsupported OpenRouter chat completion stream chunk',
                },
              });
            }
            // Ignore forward-compatible provider metadata events that do not map
            // to Anthropic Messages streaming semantics.
            continue;
          }

          // Observe reasoning only after the event is known-supported, so a
          // chunk we are about to reject cannot emit reasoning activity (which
          // feeds the TTFB/idle timers) first.
          const reasoningSignal = detectReasoningSignal(payload);
          if (reasoningSignal) {
            onReasoningObserved?.(reasoningSignal);
          }
          const reasoningText = extractReasoningDeltaText(payload);
          if (reasoningText) {
            onReasoningDelta?.(reasoningText);
          }

          if (effectiveEvent === 'message_start') {
            const nextUsage = mergeUsage(usage, normalizeUsage(payload.message?.usage));
            if (!usageEquals(usage, nextUsage)) {
              usage = nextUsage;
              if (usage) {
                onUsage?.(usage);
              }
            } else {
              usage = nextUsage;
            }
          }

          if (effectiveEvent === 'message_delta') {
            if ('stop_reason' in (payload.delta ?? {})) {
              onStopReason?.(payload.delta?.stop_reason ?? null);
            }
            const nextUsage = mergeUsage(usage, normalizeUsage(payload.usage));
            if (!usageEquals(usage, nextUsage)) {
              usage = nextUsage;
              if (usage) {
                onUsage?.(usage);
              }
            } else {
              usage = nextUsage;
            }
          }

          if (
            effectiveEvent === 'content_block_delta' &&
            payload.delta?.type === 'text_delta' &&
            payload.delta.text
          ) {
            rawText += payload.delta.text;
            onText(payload.delta.text);
          }
        }

        if (done) {
          break;
        }
      }
    } finally {
      // Release the HTTP body on every exit path — including throws from
      // inside the loop (error events, unsupported chat-completion chunks),
      // which do not abort the consumer signal and would otherwise leave the
      // reader/body locked.
      reader.cancel().catch(() => {});
    }

    return rawText;
  }
}
