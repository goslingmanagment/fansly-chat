import { MAX_TOKENS, OPENROUTER_MESSAGES_API_URL } from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import type {
  AnthropicUsageMetrics,
  FeatureType,
  PromptTextBlock,
} from '../shared/types.js';
import {
  mergeUsage,
  parseRetryAfterMs,
  parseSseBlock,
  usageEquals,
} from './anthropic-client.js';

interface OpenRouterStreamArgs {
  apiKey: string;
  model: string;
  temperature: number;
  systemBlocks: PromptTextBlock[];
  userBlocks: PromptTextBlock[];
  feature: FeatureType;
  signal: AbortSignal;
  onText: (text: string) => void;
  onUsage?: (usage: AnthropicUsageMetrics) => void;
  onProgress?: () => void;
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

type OpenRouterUsagePayload = Partial<AnthropicUsageMetrics> & {
  prompt_tokens?: number;
  completion_tokens?: number;
};

function stripCacheControl(blocks: PromptTextBlock[]): PromptTextBlock[] {
  return blocks.map((block) => ({
    type: block.type,
    text: block.text,
  }));
}

function normalizeUsage(
  usage: OpenRouterUsagePayload | null | undefined,
): Partial<AnthropicUsageMetrics> | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : usage.prompt_tokens;
  const outputTokens =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : usage.completion_tokens;
  const normalized: Partial<AnthropicUsageMetrics> = {};

  if (typeof inputTokens === 'number') {
    normalized.input_tokens = inputTokens;
  }
  normalized.cache_creation_input_tokens = 0;
  if (typeof usage.cache_read_input_tokens === 'number') {
    normalized.cache_read_input_tokens = usage.cache_read_input_tokens;
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
    matchesMessage(normalizedMessage, [
      'insufficient credits',
      'insufficient balance',
      'payment required',
      'billing',
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
    matchesMessage(normalizedMessage, [
      'model not found',
      'invalid model',
      'not a valid model',
      'does not exist',
      'is unavailable',
      'not found',
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
    signal,
    onText,
    onUsage,
    onProgress,
  }: OpenRouterStreamArgs): Promise<string> {
    let rawText = '';
    let usage: AnthropicUsageMetrics | null = null;
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
        max_tokens: MAX_TOKENS[feature],
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
          message?: { usage?: OpenRouterUsagePayload };
          usage?: OpenRouterUsagePayload;
          delta?: { type?: string; text?: string };
          error?: { type?: string; message?: string; code?: number | string };
        };
        try {
          payload = JSON.parse(parsed.data) as typeof payload;
        } catch {
          continue;
        }

        onProgress?.();

        if (parsed.event === 'error' || payload.type === 'error') {
          throw buildOpenRouterError(0, payload.error ?? null);
        }

        if (parsed.event === 'message_start') {
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

        if (parsed.event === 'message_delta') {
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

    return rawText;
  }
}
