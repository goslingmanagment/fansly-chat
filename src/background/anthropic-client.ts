import { ANTHROPIC_VERSION, CLAUDE_API_URL, MAX_TOKENS } from '../shared/constants.js';
import { ChatMuseError } from '../shared/errors.js';
import type {
  AnthropicCacheCreationUsage,
  AnthropicUsageMetrics,
  FeatureType,
  PromptTextBlock,
} from '../shared/types.js';

interface StreamArgs {
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

function parseSseBlock(block: string): { event: string; data: string } | null {
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

function mergeUsage(
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

function usageEquals(
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
  }: StreamArgs): Promise<string> {
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

    if (response.status === 401 || response.status === 403) {
      throw new ChatMuseError('invalid_api_key');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ChatMuseError('claude_overloaded');
    }
    if (response.status === 400) {
      try {
        const body = await response.json() as { error?: { type?: string; message?: string } };
        const errType = body?.error?.type ?? '';
        const errMsg = body?.error?.message?.toLowerCase() ?? '';
        if (
          errType === 'not_found_error' ||
          errMsg.includes('not found') ||
          errMsg.includes('does not exist') ||
          errMsg.includes('deprecated')
        ) {
          throw new ChatMuseError('model_unavailable');
        }
      } catch (e) {
        if (e instanceof ChatMuseError) throw e;
      }
      throw new ChatMuseError('unknown_error');
    }
    if (!response.ok || !response.body) {
      throw new ChatMuseError('network_error');
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

        // Protect against malformed SSE data
        let payload: {
          type?: string;
          message?: { usage?: Partial<AnthropicUsageMetrics> };
          usage?: Partial<AnthropicUsageMetrics>;
          delta?: { type?: string; text?: string };
          error?: { type?: string };
        };
        try {
          payload = JSON.parse(parsed.data) as typeof payload;
        } catch {
          continue;
        }

        onProgress?.();

        if (parsed.event === 'error' || payload.type === 'error') {
          throw new ChatMuseError('claude_overloaded');
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
