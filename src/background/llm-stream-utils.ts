import type {
  LlmCacheCreationUsage,
  LlmUsageMetrics,
} from '../shared/types.js';

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

function extractReasoningText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const record = value as {
    thinking?: unknown;
    reasoning?: unknown;
    text?: unknown;
    content?: unknown;
  };
  for (const key of ['thinking', 'reasoning', 'text', 'content'] as const) {
    const text = record[key];
    if (typeof text === 'string') {
      return text;
    }
  }

  return '';
}

export function extractReasoningDeltaText(payload: {
  delta?: {
    type?: string;
    thinking?: unknown;
    reasoning?: unknown;
  };
  reasoning?: unknown;
  choices?: unknown[];
}): string {
  if (payload.delta?.type === 'thinking_delta') {
    return extractReasoningText(payload.delta.thinking);
  }

  const directReasoning = extractReasoningText(payload.delta?.reasoning ?? payload.reasoning);
  if (directReasoning) {
    return directReasoning;
  }

  for (const choice of payload.choices ?? []) {
    const candidate = choice as {
      delta?: { reasoning?: unknown };
      message?: { reasoning?: unknown };
    };
    const choiceReasoning = extractReasoningText(
      candidate.delta?.reasoning ?? candidate.message?.reasoning,
    );
    if (choiceReasoning) {
      return choiceReasoning;
    }
  }

  return '';
}

export function mergeUsage(
  current: LlmUsageMetrics | null,
  next?: Partial<LlmUsageMetrics>,
): LlmUsageMetrics | null {
  if (!next) {
    return current;
  }

  const nextCacheCreation = next.cache_creation as Partial<LlmCacheCreationUsage> | undefined;
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
  left: LlmUsageMetrics | null,
  right: LlmUsageMetrics | null,
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
