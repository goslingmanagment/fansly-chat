import { ANTHROPIC_VERSION, MAX_TOKENS } from '../shared/constants.js';
import {
  resolveClaudeProviderSettings,
} from '../shared/claude-api.js';
import { ChatMuseError } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import {
  buildHostAccessMissingDetail,
  getProviderDiagnostics,
} from '../shared/provider-runtime.js';
import type {
  AnthropicCacheCreationUsage,
  AnthropicUsageMetrics,
  ClaudeProvider,
  FeatureType,
  PromptPayload,
  PromptTextBlock,
  ProviderConnectionTestResult,
} from '../shared/types.js';

const API_KEY_REGEX = /sk-(?:ant|aw)-[a-zA-Z0-9_-]+/g;
const MAX_ERROR_DETAIL_LENGTH = 180;

interface StreamArgs {
  provider: ClaudeProvider;
  apiKey: string;
  model: string;
  systemBlocks: PromptTextBlock[];
  userBlocks: PromptTextBlock[];
  feature: FeatureType;
  debugEnabled: boolean;
  signal: AbortSignal;
  onText: (text: string) => void;
  onUsage?: (usage: AnthropicUsageMetrics) => void;
}

interface ProviderErrorBody {
  error?: { type?: string; message?: string };
}

interface ConnectionTestArgs {
  provider: ClaudeProvider;
  apiKey: string;
  model: string;
  debugEnabled: boolean;
}

const CONNECTION_TEST_TIMEOUT_MS = 15_000;

function providerLabel(provider: ClaudeProvider): string {
  return provider === 'kiro' ? 'Kiro' : 'Anthropic';
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(API_KEY_REGEX, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipDiagnosticText(value: string): string {
  return value.length <= MAX_ERROR_DETAIL_LENGTH
    ? value
    : `${value.slice(0, MAX_ERROR_DETAIL_LENGTH - 1).trimEnd()}…`;
}

function technicalDetail(provider: ClaudeProvider, summary: string): string {
  return clipDiagnosticText(`${providerLabel(provider)}: ${sanitizeDiagnosticText(summary)}`);
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    const summary = error.message ? `${error.name}: ${error.message}` : error.name;
    return sanitizeDiagnosticText(summary || 'Unknown error');
  }

  if (typeof error === 'string') {
    return sanitizeDiagnosticText(error);
  }

  return 'Unknown error';
}

function responseDetail(
  provider: ClaudeProvider,
  status: number,
  suffix?: string,
): string {
  const base = `HTTP ${status}`;
  return technicalDetail(provider, suffix ? `${base} (${suffix}).` : `${base}.`);
}

function streamDetail(
  provider: ClaudeProvider,
  event: string,
  errorType?: string,
  errorMessage?: string,
): string {
  const detailParts = [sanitizeDiagnosticText(event)];
  if (errorType) {
    detailParts.push(sanitizeDiagnosticText(errorType));
  }
  if (errorMessage) {
    detailParts.push(sanitizeDiagnosticText(errorMessage));
  }
  return technicalDetail(
    provider,
    `Stream error event: ${detailParts.filter(Boolean).join(' | ')}.`,
  );
}

function preResponseFailureDetail(
  provider: ClaudeProvider,
  requestHost: string,
  error: unknown,
): string {
  if (provider === 'kiro') {
    return technicalDetail(
      provider,
      `Request failed before a response was received (${errorSummary(error)}). Firefox may be treating ${requestHost} as a normal browser CORS request. Reload or reinstall the extension, then run the provider self-test in Settings.`,
    );
  }

  return technicalDetail(
    provider,
    `Request failed before a response was received (${errorSummary(error)}).`,
  );
}

function buildHeaders(resolvedProvider: ReturnType<typeof resolveClaudeProviderSettings>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': resolvedProvider.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };

  if (resolvedProvider.sendDangerousDirectBrowserAccessHeader) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  return headers;
}

function buildStreamBody(
  model: string,
  feature: FeatureType,
  systemBlocks: PromptTextBlock[],
  userBlocks: PromptTextBlock[],
  maxTokens = MAX_TOKENS[feature],
): string {
  return JSON.stringify({
    model,
    stream: true,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: [{ role: 'user', content: userBlocks }],
  });
}

function buildConnectionTestPayload(model: string): PromptPayload {
  return {
    system: 'Connection test',
    user: 'Reply with OK.',
    systemBlocks: [{ type: 'text', text: 'Connection test. Reply with OK.' }],
    userBlocks: [{ type: 'text', text: 'Reply with OK.' }],
  };
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
  async testConnection({
    provider,
    apiKey,
    model,
    debugEnabled,
  }: ConnectionTestArgs): Promise<ProviderConnectionTestResult> {
    const resolvedProvider = resolveClaudeProviderSettings({
      claudeProvider: provider,
      anthropicApiKey: provider === 'anthropic' ? apiKey : '',
      kiroApiKey: provider === 'kiro' ? apiKey : '',
    });
    const diagnostics = await getProviderDiagnostics({
      claudeProvider: provider,
      anthropicApiKey: provider === 'anthropic' ? apiKey : '',
      kiroApiKey: provider === 'kiro' ? apiKey : '',
    });
    const checkedAt = Date.now();

    if (!diagnostics.hasApiKey) {
      return {
        ...diagnostics,
        checkedAt,
        status: 'missing_api_key',
        detail: technicalDetail(provider, 'API key is missing.'),
      };
    }

    if (!diagnostics.hostPermissionGranted) {
      return {
        ...diagnostics,
        checkedAt,
        status: 'host_access_missing',
        detail: buildHostAccessMissingDetail(provider, diagnostics.requestHost),
      };
    }

    const requestContext = {
      provider,
      requestUrl: resolvedProvider.messagesUrl,
      requestHost: diagnostics.requestHost,
      model,
      feature: 'fast-reply' as const,
      connectionTest: true,
    };

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      controller.abort();
    }, CONNECTION_TEST_TIMEOUT_MS);

    try {
      const probePayload = buildConnectionTestPayload(model);
      const response = await fetch(resolvedProvider.messagesUrl, {
        method: 'POST',
        headers: buildHeaders(resolvedProvider),
        signal: controller.signal,
        body: buildStreamBody(
          model,
          'fast-reply',
          probePayload.systemBlocks,
          probePayload.userBlocks,
          1,
        ),
      });

      if (response.status === 401 || response.status === 403) {
        return {
          ...diagnostics,
          checkedAt,
          status: 'invalid_api_key',
          detail: responseDetail(provider, response.status),
          httpStatus: response.status,
        };
      }

      if (!response.ok || !response.body) {
        return {
          ...diagnostics,
          checkedAt,
          status: 'http_error',
          detail: !response.body
            ? responseDetail(provider, response.status, 'no streaming body')
            : responseDetail(provider, response.status),
          httpStatus: response.status,
        };
      }

      void response.body.cancel().catch(() => undefined);

      return {
        ...diagnostics,
        checkedAt,
        status: 'ready',
        detail: technicalDetail(provider, `Connection test succeeded (HTTP ${response.status}).`),
        httpStatus: response.status,
      };
    } catch (error) {
      logDebug(debugEnabled, 'claude connection test failed', {
        ...requestContext,
        error,
      });

      return {
        ...diagnostics,
        checkedAt,
        status: 'pre_response_failure',
        detail: preResponseFailureDetail(provider, diagnostics.requestHost, error),
      };
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async streamMessage({
    provider,
    apiKey,
    model,
    systemBlocks,
    userBlocks,
    feature,
    debugEnabled,
    signal,
    onText,
    onUsage,
  }: StreamArgs): Promise<string> {
    let rawText = '';
    let usage: AnthropicUsageMetrics | null = null;
    const resolvedProvider = resolveClaudeProviderSettings({
      claudeProvider: provider,
      anthropicApiKey: provider === 'anthropic' ? apiKey : '',
      kiroApiKey: provider === 'kiro' ? apiKey : '',
    });
    const headers = buildHeaders(resolvedProvider);

    const requestUrl = resolvedProvider.messagesUrl;
    const requestHost = new URL(requestUrl).host;
    const requestContext = {
      provider,
      requestUrl,
      requestHost,
      model,
      feature,
    };

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers,
        signal,
        body: buildStreamBody(model, feature, systemBlocks, userBlocks),
      });
    } catch (error) {
      logDebug(debugEnabled, 'claude request failed', {
        ...requestContext,
        error,
      });
      const diagnostics = await getProviderDiagnostics({
        claudeProvider: provider,
        anthropicApiKey: provider === 'anthropic' ? apiKey : '',
        kiroApiKey: provider === 'kiro' ? apiKey : '',
      });
      if (!diagnostics.hostPermissionGranted) {
        throw new ChatMuseError(
          'provider_host_access_missing',
          buildHostAccessMissingDetail(provider, requestHost),
          undefined,
          false,
          provider,
        );
      }
      if (provider === 'kiro') {
        throw new ChatMuseError(
          'provider_connection_failed',
          preResponseFailureDetail(provider, requestHost, error),
          undefined,
          false,
          provider,
        );
      }
      throw new ChatMuseError(
        'network_error',
        preResponseFailureDetail(provider, requestHost, error),
        undefined,
        false,
        provider,
      );
    }

    if (response.status === 401 || response.status === 403) {
      logDebug(debugEnabled, 'claude response error', {
        ...requestContext,
        status: response.status,
        statusText: response.statusText,
      });
      throw new ChatMuseError(
        'invalid_api_key',
        responseDetail(provider, response.status),
        undefined,
        false,
        provider,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      logDebug(debugEnabled, 'claude response error', {
        ...requestContext,
        status: response.status,
        statusText: response.statusText,
      });
      throw new ChatMuseError(
        'claude_overloaded',
        responseDetail(provider, response.status),
        undefined,
        false,
        provider,
      );
    }
    if (response.status === 400) {
      let body: ProviderErrorBody | null = null;
      let bodyParseError: unknown;
      try {
        body = await response.json() as ProviderErrorBody;
      } catch (error) {
        bodyParseError = error;
      }

      const errType = body?.error?.type ?? '';
      const errMsg = body?.error?.message?.toLowerCase() ?? '';
      const diagnosticSuffix = [errType, body?.error?.message]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .map((part) => sanitizeDiagnosticText(part))
        .join(' | ');

      logDebug(debugEnabled, 'claude response error', {
        ...requestContext,
        status: response.status,
        statusText: response.statusText,
        providerErrorType: errType || undefined,
        providerErrorMessage: body?.error?.message ? sanitizeDiagnosticText(body.error.message) : undefined,
        bodyParseError,
      });

      if (
        errType === 'not_found_error' ||
        errMsg.includes('not found') ||
        errMsg.includes('does not exist') ||
        errMsg.includes('deprecated')
      ) {
        throw new ChatMuseError(
          'model_unavailable',
          responseDetail(provider, response.status, diagnosticSuffix || `model ${model} is unavailable`),
          undefined,
          false,
          provider,
        );
      }

      if (bodyParseError) {
        throw new ChatMuseError(
          'unknown_error',
          technicalDetail(provider, 'HTTP 400 response body could not be parsed.'),
          undefined,
          false,
          provider,
        );
      }

      throw new ChatMuseError(
        'unknown_error',
        responseDetail(provider, response.status, diagnosticSuffix || 'request rejected'),
        undefined,
        false,
        provider,
      );
    }
    if (!response.ok || !response.body) {
      logDebug(debugEnabled, 'claude response error', {
        ...requestContext,
        status: response.status,
        statusText: response.statusText,
        hasBody: Boolean(response.body),
      });
      const detail = !response.body
        ? responseDetail(provider, response.status, 'no streaming body')
        : responseDetail(provider, response.status);
      throw new ChatMuseError('network_error', detail, undefined, false, provider);
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
          error?: { type?: string; message?: string };
        };
        try {
          payload = JSON.parse(parsed.data) as typeof payload;
        } catch {
          continue;
        }

        if (parsed.event === 'error' || payload.type === 'error') {
          logDebug(debugEnabled, 'claude stream error', {
            ...requestContext,
            sseEvent: parsed.event,
            providerErrorType: payload.error?.type,
            providerErrorMessage: payload.error?.message
              ? sanitizeDiagnosticText(payload.error.message)
              : undefined,
          });
          throw new ChatMuseError(
            'claude_overloaded',
            streamDetail(provider, parsed.event, payload.error?.type, payload.error?.message),
            undefined,
            false,
            provider,
          );
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
