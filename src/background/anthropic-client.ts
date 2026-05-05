import { ANTHROPIC_VERSION, CLAUDE_API_URL, MAX_TOKENS } from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import type {
  AnthropicCacheCreationUsage,
  AnthropicUsageMetrics,
  FeatureType,
  PromptTextBlock,
} from '../shared/types.js';

export interface AnthropicStreamArgs {
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

export function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n').map((line) => line.trim());
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

export function mergeUsage(
  current: AnthropicUsageMetrics | null,
  next?: Partial<AnthropicUsageMetrics>,
): AnthropicUsageMetrics | null {
  if (!next) {
    return current;
  }

  const nextCacheCreation = next.cache_creation as Partial<AnthropicCacheCreationUsage> | undefined;
  const currentCacheCreation = current?.cache_creation;
  const cacheCreation = nextCacheCreation || currentCacheCreation
    ? {
        ephemeral_5m_input_tokens:
          typeof nextCacheCreation?.ephemeral_5m_input_tokens === 'number'
            ? nextCacheCreation.ephemeral_5m_input_tokens
            : currentCacheCreation?.ephemeral_5m_input_tokens ?? 0,
        ephemeral_1h_input_tokens:
          typeof nextCacheCreation?.ephemeral_1h_input_tokens === 'number'
            ? nextCacheCreation.ephemeral_1h_input_tokens
            : currentCacheCreation?.ephemeral_1h_input_tokens ?? 0,
      }
    : undefined;

  return {
    input_tokens:
      typeof next.input_tokens === 'number'
        ? next.input_tokens
        : current?.input_tokens ?? 0,
    cache_creation_input_tokens:
      typeof next.cache_creation_input_tokens === 'number'
        ? next.cache_creation_input_tokens
        : current?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens:
      typeof next.cache_read_input_tokens === 'number'
        ? next.cache_read_input_tokens
        : current?.cache_read_input_tokens ?? 0,
    output_tokens:
      typeof next.output_tokens === 'number'
        ? next.output_tokens
        : current?.output_tokens ?? 0,
    ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
  };
}

export function usageEquals(
  left: AnthropicUsageMetrics | null,
  right: AnthropicUsageMetrics | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.input_tokens === right.input_tokens &&
    left.cache_creation_input_tokens === right.cache_creation_input_tokens &&
    left.cache_read_input_tokens === right.cache_read_input_tokens &&
    left.output_tokens === right.output_tokens &&
    (left.cache_creation?.ephemeral_5m_input_tokens ?? 0) ===
      (right.cache_creation?.ephemeral_5m_input_tokens ?? 0) &&
    (left.cache_creation?.ephemeral_1h_input_tokens ?? 0) ===
      (right.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  );
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

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - Date.now());
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
    signal,
    onText,
    onUsage,
    onProgress,
  }: AnthropicStreamArgs): Promise<string> {
    let rawText = '';
    let usage: AnthropicUsageMetrics | null = null;
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal,
      body: JSON.stringify({
        model,
        temperature,
        stream: true,
        max_tokens: MAX_TOKENS[feature],
        system: systemBlocks,
        messages: [{ role: 'user', content: userBlocks }],
      }),
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
          message?: { usage?: Partial<AnthropicUsageMetrics> };
          usage?: Partial<AnthropicUsageMetrics>;
          delta?: { type?: string; text?: string };
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

    return rawText;
  }
}
