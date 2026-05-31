import { ANTHROPIC_VERSION, CLAUDE_API_URL, MAX_TOKENS } from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import {
  getAnthropicAdaptiveThinkingMaxTokens,
  supportsAnthropicAdaptiveThinking,
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

export interface AnthropicStreamArgs {
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

interface AnthropicApiErrorBody {
  error?: {
    type?: string;
    message?: string;
  };
}

interface AnthropicApiErrorInfo {
  type?: string;
  message?: string;
}

type AnthropicThinkingEffort = Exclude<ReasoningEffort, 'off'>;

function resolveMaxTokens(model: string, feature: FeatureType): number {
  if (supportsAnthropicAdaptiveThinking(model)) {
    return getAnthropicAdaptiveThinkingMaxTokens(feature) ?? MAX_TOKENS[feature];
  }
  return MAX_TOKENS[feature];
}

function buildAdaptiveThinkingConfig(
  model: string,
  reasoningEffort: ReasoningEffort,
): {
  thinking?: { type: 'adaptive'; display: 'summarized' };
  output_config?: { effort: AnthropicThinkingEffort };
} {
  if (!supportsAnthropicAdaptiveThinking(model) || reasoningEffort === 'off') {
    return {};
  }

  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: reasoningEffort },
  };
}

function detectReasoningSignal(payload: {
  content_block?: { type?: string };
  delta?: { type?: string; reasoning?: unknown };
  reasoning?: unknown;
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

  if (payload.delta?.reasoning !== undefined || payload.reasoning !== undefined) {
    return 'reasoning_delta';
  }

  return null;
}

function getHeader(response: Response, name: string): string | null {
  if (!response.headers || typeof response.headers.get !== 'function') {
    return null;
  }
  return response.headers.get(name);
}

async function readAnthropicError(response: Response): Promise<AnthropicApiErrorInfo | null> {
  if (typeof response.json !== 'function') {
    return null;
  }

  try {
    const body = await response.json() as AnthropicApiErrorBody;
    return body.error
      ? {
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

function isInsufficientBalanceError(type: string, message: string): boolean {
  return (
    type === 'insufficient_balance_error' ||
    type === 'payment_required_error' ||
    matchesMessage(message, [
      'insufficient balance',
      'insufficient credits',
      'credit balance is too low',
      'billing',
      'payment required',
    ])
  );
}

function isModelUnavailableError(type: string, message: string): boolean {
  return (
    type === 'not_found_error' ||
    matchesMessage(message, [
      'model not found',
      'does not exist',
      'is unavailable',
      'deprecated',
      'not found',
    ])
  );
}

function isContextTooLongError(type: string, message: string): boolean {
  return (
    type === 'context_window_exceeded_error' ||
    matchesMessage(message, [
      'prompt is too long',
      'context length',
      'maximum context length',
      'too many tokens',
      'request is too large',
      'input is too long',
    ])
  );
}

function buildAnthropicError(
  status: number,
  info: AnthropicApiErrorInfo | null,
  retryAfterMs?: number,
): ChatGooseError {
  const type = info?.type?.trim().toLowerCase() ?? '';
  const message = info?.message?.trim() ?? '';
  const normalizedMessage = message.toLowerCase();
  const details = {
    ...(status > 0 ? { status } : {}),
    ...(message ? { providerMessage: message } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAtMs: Date.now() + retryAfterMs } : {}),
  };

  if (status === 429 || type === 'rate_limit_error' || normalizedMessage.includes('rate limit')) {
    return new ChatGooseError('rate_limited', {
      details,
      retryAfterMs,
      retryAtMs: details.retryAtMs,
    });
  }

  if (isInsufficientBalanceError(type, normalizedMessage)) {
    return new ChatGooseError('insufficient_balance', { details });
  }

  if (status === 401 || status === 403) {
    return new ChatGooseError('invalid_api_key', { details });
  }

  if (isModelUnavailableError(type, normalizedMessage)) {
    return new ChatGooseError('model_unavailable', { details });
  }

  if (status === 413 || isContextTooLongError(type, normalizedMessage)) {
    return new ChatGooseError('context_too_long', { details });
  }

  if (status === 529 || status >= 500 || type === 'overloaded_error') {
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

export class AnthropicClient {
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
  }: AnthropicStreamArgs): Promise<string> {
    let rawText = '';
    let usage: LlmUsageMetrics | null = null;
    const adaptiveThinkingConfig = buildAdaptiveThinkingConfig(model, reasoningEffort);
    const requestBody: Record<string, unknown> = {
      model,
      stream: true,
      max_tokens: resolveMaxTokens(model, feature),
      ...adaptiveThinkingConfig,
      system: systemBlocks,
      messages: [{ role: 'user', content: userBlocks }],
    };

    if (!adaptiveThinkingConfig.thinking) {
      requestBody.temperature = temperature;
    }

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorInfo = await readAnthropicError(response);
      const retryAfterMs = parseRetryAfterMs(getHeader(response, 'retry-after'));
      throw buildAnthropicError(response.status, errorInfo, retryAfterMs);
    }

    if (!response.body) {
      throw new ChatGooseError('network_error');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed || parsed.data === '[DONE]') {
            continue;
          }

          let payload: {
            type?: string;
            message?: { usage?: Partial<LlmUsageMetrics> };
            content_block?: { type?: string };
            usage?: Partial<LlmUsageMetrics>;
            delta?: {
              type?: string;
              thinking?: unknown;
              text?: string;
              stop_reason?: string | null;
              reasoning?: unknown;
            };
            reasoning?: unknown;
            error?: { type?: string; message?: string };
          };
          try {
            payload = JSON.parse(parsed.data) as typeof payload;
          } catch {
            continue;
          }

          onProgress?.();

          if (parsed.event === 'error' || payload.type === 'error') {
            throw buildAnthropicError(0, payload.error ?? null);
          }

          const reasoningSignal = detectReasoningSignal(payload);
          if (reasoningSignal) {
            onReasoningObserved?.(reasoningSignal);
          }
          const reasoningText = extractReasoningDeltaText(payload);
          if (reasoningText) {
            onReasoningDelta?.(reasoningText);
          }

          if (parsed.event === 'message_start') {
            const nextUsage = mergeUsage(usage, payload.message?.usage);
            if (!usageEquals(usage, nextUsage)) {
              usage = nextUsage;
              if (usage) {
                onUsage?.(usage);
              }
            } else {
              usage = nextUsage;
            }
          }

          if (parsed.event === 'message_delta') {
            if ('stop_reason' in (payload.delta ?? {})) {
              onStopReason?.(payload.delta?.stop_reason ?? null);
            }
            const nextUsage = mergeUsage(usage, payload.usage);
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
            parsed.event === 'content_block_delta' &&
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
      // inside the loop (mid-stream error events), which do not abort the
      // consumer signal and would otherwise leave the reader/body locked.
      reader.cancel().catch(() => {});
    }

    return rawText;
  }
}
