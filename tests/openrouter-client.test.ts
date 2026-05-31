import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOKENS, OPENROUTER_MESSAGES_API_URL } from '../src/shared/constants.js';
import { OpenRouterClient } from '../src/background/openrouter-client.js';

function mockFetchResponse(status: number, body?: unknown, options?: { bodyStream?: string }) {
  const response: Partial<Response> = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: vi.fn(() => null),
    } as unknown as Headers,
    json: vi.fn(async () => body),
    body: options?.bodyStream
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(options.bodyStream));
            controller.close();
          },
        }) as unknown as Response['body']
      : null,
  };
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return response;
}

function streamArgs(
  overrides?: Partial<Parameters<OpenRouterClient['streamMessage']>[0]>,
): Parameters<OpenRouterClient['streamMessage']>[0] {
  return {
    apiKey: 'sk-or-v1-test',
    model: 'x-ai/grok-4.3',
    temperature: 0.65,
    systemBlocks: [
      {
        type: 'text',
        text: 'system cached',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    userBlocks: [
      {
        type: 'text',
        text: 'user dynamic',
        cache_control: { type: 'ephemeral' },
      },
    ],
    feature: 'fast-reply',
    reasoningEffort: 'medium',
    signal: new AbortController().signal,
    onText: vi.fn(),
    onUsage: vi.fn(),
    ...overrides,
  };
}

describe('OpenRouterClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the OpenRouter Messages endpoint and strips cache_control without mutating original blocks', async () => {
    const args = streamArgs();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(args);

    const fetchMock = vi.mocked(fetch);
    const [url, request] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(request?.body)) as {
      model: string;
      max_tokens: number;
      thinking?: unknown;
      output_config?: unknown;
      system: Array<{ cache_control?: unknown; text: string }>;
      messages: Array<{ role: string; content: Array<{ cache_control?: unknown; text: string }> }>;
    };

    expect(url).toBe(OPENROUTER_MESSAGES_API_URL);
    expect((request?.headers as Record<string, string>).authorization).toBe('Bearer sk-or-v1-test');
    expect(body.model).toBe('x-ai/grok-4.3');
    expect(body.max_tokens).toBe(MAX_TOKENS['fast-reply']);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.system[0]).toEqual({ type: 'text', text: 'system cached' });
    expect(body.messages[0]?.content[0]).toEqual({ type: 'text', text: 'user dynamic' });
    expect(args.systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(args.userBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses medium omitted thinking and a larger budget for short Gemini reply features by default', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(
      streamArgs({ model: 'google/gemini-3.1-pro-preview' }),
    );

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(1600);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it('omits Gemini thinking config when reasoning is off', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(
      streamArgs({
        model: 'google/gemini-3.1-pro-preview',
        reasoningEffort: 'off',
      }),
    );

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(1600);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('maps max Gemini reasoning to high for OpenRouter', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(
      streamArgs({
        model: 'google/gemini-3.1-pro-preview',
        reasoningEffort: 'max',
      }),
    );

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(request?.body)) as {
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('reports observed reasoning blocks from the OpenRouter Messages stream', async () => {
    const onReasoningObserved = vi.fn();
    const onReasoningDelta = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: content_block_start',
        'data: {"type":"content_block_start","content_block":{"type":"thinking"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"checking context"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
        '',
        '',
      ].join('\n'),
    });

    await expect(new OpenRouterClient().streamMessage(
      streamArgs({
        model: 'google/gemini-3.1-pro-preview',
        onReasoningObserved,
        onReasoningDelta,
      }),
    )).resolves.toBe('ok');

    expect(onReasoningObserved).toHaveBeenCalledWith('thinking_block');
    expect(onReasoningObserved).toHaveBeenCalledWith('thinking_delta');
    expect(onReasoningObserved).toHaveBeenCalledWith('signature_delta');
    expect(onReasoningDelta).toHaveBeenCalledWith('checking context');
  });

  it.each([
    ['delta', '{"type":"message_delta","choices":[{"delta":{"reasoning":""}}]}'],
    ['message', '{"type":"message_delta","choices":[{"message":{"reasoning":""}}]}'],
  ])('reports empty choices[].%s.reasoning as observed reasoning', async (_shape, data) => {
    const onReasoningObserved = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_delta',
        `data: ${data}`,
        '',
        '',
      ].join('\n'),
    });

    await expect(new OpenRouterClient().streamMessage(
      streamArgs({ onReasoningObserved }),
    )).resolves.toBe('');

    expect(onReasoningObserved).toHaveBeenCalledWith('reasoning_delta');
  });

  it('keeps the default budget and thinking config for deep Gemini features', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(
      streamArgs({
        model: 'google/gemini-3.1-pro-preview',
        feature: 'fan-summary',
      }),
    );

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(MAX_TOKENS['fan-summary']);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('calls onText for content_block_delta text deltas', async () => {
    const onText = vi.fn();
    const onUsage = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        ': OPENROUTER PROCESSING',
        '',
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    const rawText = await new OpenRouterClient().streamMessage(
      streamArgs({ onText, onUsage }),
    );

    expect(rawText).toBe('hi');
    expect(onText).toHaveBeenCalledWith('hi');
    expect(onUsage).toHaveBeenLastCalledWith({
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    });
  });

  it('parses events separated by CRLF blank lines', async () => {
    const onText = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"crlf"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\r\n'),
    });

    const rawText = await new OpenRouterClient().streamMessage(streamArgs({ onText }));

    expect(rawText).toBe('crlf');
    expect(onText).toHaveBeenCalledWith('crlf');
  });

  it('reports Anthropic message stop reasons from the OpenRouter stream', async () => {
    const onStopReason = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":800}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(streamArgs({ onStopReason }));

    expect(onStopReason).toHaveBeenCalledWith('max_tokens');
  });

  it('handles data-only Anthropic message events by using payload.type', async () => {
    const onText = vi.fn();
    const onUsage = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":1}}}',
        '',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        '',
        'data: {"type":"message_delta","usage":{"output_tokens":2}}',
        '',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    const rawText = await new OpenRouterClient().streamMessage(
      streamArgs({ onText, onUsage }),
    );

    expect(rawText).toBe('hi');
    expect(onText).toHaveBeenCalledWith('hi');
    expect(onUsage).toHaveBeenLastCalledWith({
      input_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 2,
    });
  });

  it('preserves Anthropic-shaped cache read and write usage', async () => {
    const onUsage = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":42,"cache_read_input_tokens":7,"output_tokens":1}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"cache_read_input_tokens":99,"output_tokens":3}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(streamArgs({ onUsage }));

    expect(onUsage).toHaveBeenLastCalledWith({
      input_tokens: 10,
      cache_creation_input_tokens: 42,
      cache_read_input_tokens: 99,
      output_tokens: 3,
    });
  });

  it('maps OpenAI-shaped usage without prompt token details to uncached input', async () => {
    const onUsage = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"prompt_tokens":1000,"completion_tokens":100}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(streamArgs({ onUsage }));

    expect(onUsage).toHaveBeenLastCalledWith({
      input_tokens: 1000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
    });
  });

  it('maps OpenAI-shaped usage with prompt token details without double-counting cached tokens', async () => {
    const onUsage = vi.fn();
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":300,"cache_write_tokens":200}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });

    await new OpenRouterClient().streamMessage(streamArgs({ onUsage }));

    expect(onUsage).toHaveBeenLastCalledWith({
      input_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
      output_tokens: 100,
    });
  });

  it('rejects unsupported OpenAI chat completion chunks on the Messages stream', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    });

    await expect(new OpenRouterClient().streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({
        key: 'unknown_error',
        details: expect.objectContaining({ provider: 'openrouter' }),
      }),
    );
  });

  it('classifies data-only stream error payloads before event validation', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'data: {"error":{"code":429,"message":"rate limit exceeded"}}',
        '',
        '',
      ].join('\n'),
    });

    await expect(new OpenRouterClient().streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({
        key: 'rate_limited',
        details: expect.objectContaining({ provider: 'openrouter' }),
      }),
    );
  });

  it('maps OpenRouter model errors without retrying another endpoint', async () => {
    mockFetchResponse(404, {
      error: { code: 404, message: 'Invalid model specified' },
    });

    await expect(new OpenRouterClient().streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({
        key: 'model_unavailable',
        details: expect.objectContaining({ provider: 'openrouter' }),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
