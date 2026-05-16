import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MAX_TOKENS } from '../src/shared/constants.js';
import { ChatGooseError } from '../src/shared/errors.js';

// ─── Mock fetch ──────────────────────────────────────────────────────────

function mockFetchResponse(status: number, body?: unknown, options?: { bodyStream?: string }) {
  const response: Partial<Response> = {
    status,
    ok: status >= 200 && status < 300,
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
  overrides?: Partial<
    Parameters<
      InstanceType<typeof import('../src/background/anthropic-client.js').AnthropicClient>['streamMessage']
    >[0]
  >,
): Parameters<
  InstanceType<typeof import('../src/background/anthropic-client.js').AnthropicClient>['streamMessage']
>[0] {
  return {
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.65,
    systemBlocks: [
      { type: 'text' as const, text: 'system prefix\n\n' },
      {
        type: 'text' as const,
        text: 'system personality',
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    userBlocks: [
      {
        type: 'text' as const,
        text: 'static user prefix',
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
      {
        type: 'text' as const,
        text: 'dynamic user context',
        cache_control: { type: 'ephemeral' as const },
      },
      { type: 'text' as const, text: 'uncached tail' },
    ],
    feature: 'fast-reply' as const,
    reasoningEffort: 'medium' as const,
    signal: new AbortController().signal,
    onText: vi.fn(),
    onUsage: vi.fn(),
    ...overrides,
  };
}

// Dynamic import to pick up stubbed fetch
let AnthropicClient: typeof import('../src/background/anthropic-client.js').AnthropicClient;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/background/anthropic-client.js');
  AnthropicClient = mod.AnthropicClient;
});

// ─── Bug 8: Error mapping ───────────────────────────────────────────────

describe('AnthropicClient error mapping', () => {
  it('maps 401 to invalid_api_key', async () => {
    mockFetchResponse(401);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'invalid_api_key', code: 'CG-AUTH-02' }),
    );
  });

  it('maps 403 to invalid_api_key', async () => {
    mockFetchResponse(403);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'invalid_api_key', code: 'CG-AUTH-02' }),
    );
  });

  it('maps 429 to rate_limited', async () => {
    mockFetchResponse(429);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'rate_limited', code: 'CG-API-01' }),
    );
  });

  it('maps 500 to service_unavailable', async () => {
    mockFetchResponse(500);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'service_unavailable', code: 'CG-API-05' }),
    );
  });

  it('maps 400 with not_found_error to model_unavailable', async () => {
    mockFetchResponse(400, {
      error: { type: 'not_found_error', message: 'model not found' },
    });
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'model_unavailable', code: 'CG-API-03' }),
    );
  });

  it('maps 400 with non-model error to unknown_error, not network_error (Bug 8)', async () => {
    mockFetchResponse(400, {
      error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' },
    });
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'unknown_error', code: 'CG-APP-01' }),
    );
  });

  it('maps 400 with unparseable body to unknown_error', async () => {
    const response: Partial<Response> = {
      status: 400,
      ok: false,
      json: vi.fn(async () => { throw new SyntaxError('Unexpected token'); }),
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'unknown_error', code: 'CG-APP-01' }),
    );
  });

  it('maps non-ok response with no body to network_error', async () => {
    // 502 hits the >= 500 check first (service_unavailable). Use 418 to test the !response.ok fallback.
    const response: Partial<Response> = {
      status: 418,
      ok: false,
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ key: 'network_error', code: 'CG-NET-01' }),
    );
  });
});

describe('AnthropicClient streaming requests', () => {
  it('sends 1-hour cache TTL blocks without an anthropic-beta header', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":4,"cache_read_input_tokens":0,"output_tokens":1}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(streamArgs());

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const headers = request?.headers as Record<string, string>;
    const body = JSON.parse(String(request?.body)) as {
      temperature: number;
      system: unknown;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers).not.toHaveProperty('anthropic-beta');
    expect(body.temperature).toBe(0.65);
    expect(body.system).toEqual(streamArgs().systemBlocks);
    expect(
      (body.system as Array<{ cache_control?: { ttl?: string } }>)[1]?.cache_control?.ttl,
    ).toBe('1h');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: streamArgs().userBlocks,
      },
    ]);
  });

  it('uses the raised 8192 max_tokens cap for fan-summary requests', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        feature: 'fan-summary',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { max_tokens: number };

    expect(body.max_tokens).toBe(8192);
    expect(body.max_tokens).toBe(MAX_TOKENS['fan-summary']);
  });

  it('uses medium summarized adaptive thinking and a large cap for Claude 4.6 reply features by default', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        model: 'claude-sonnet-4-6',
        feature: 'fast-reply',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      temperature?: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(8000);
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it('omits adaptive thinking config when reasoning is off', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        model: 'claude-sonnet-4-6',
        feature: 'fast-reply',
        reasoningEffort: 'off',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      temperature?: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(8000);
    expect(body.temperature).toBe(0.65);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it.each(['low', 'high', 'max'] as const)(
    'uses %s summarized adaptive thinking when selected',
    async (reasoningEffort) => {
      mockFetchResponse(200, undefined, {
        bodyStream: [
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ].join('\n'),
      });
      const client = new AnthropicClient();

      await client.streamMessage(
        streamArgs({
          model: 'claude-sonnet-4-6',
          feature: 'fast-reply',
          reasoningEffort,
        }),
      );

      const fetchMock = vi.mocked(fetch);
      const request = fetchMock.mock.calls[0]?.[1];
      const body = JSON.parse(String(request?.body)) as {
        temperature?: number;
        thinking?: unknown;
        output_config?: unknown;
      };

      expect(body.temperature).toBeUndefined();
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(body.output_config).toEqual({ effort: reasoningEffort });
    },
  );

  it('reports observed reasoning blocks from the Anthropic stream', async () => {
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
    const client = new AnthropicClient();

    await expect(client.streamMessage(
      streamArgs({
        model: 'claude-sonnet-4-6',
        onReasoningObserved,
        onReasoningDelta,
      }),
    )).resolves.toBe('ok');

    expect(onReasoningObserved).toHaveBeenCalledWith('thinking_block');
    expect(onReasoningObserved).toHaveBeenCalledWith('thinking_delta');
    expect(onReasoningObserved).toHaveBeenCalledWith('signature_delta');
    expect(onReasoningDelta).toHaveBeenCalledWith('checking context');
  });

  it('keeps adaptive thinking off for Claude models that do not support adaptive mode', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        model: 'claude-haiku-4-5',
        feature: 'fast-reply',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      temperature?: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(MAX_TOKENS['fast-reply']);
    expect(body.temperature).toBe(0.65);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('uses medium summarized adaptive thinking and a large cap for Claude 4.6 deep features', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        model: 'claude-opus-4-6',
        feature: 'fan-summary',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      temperature?: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(24000);
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it('uses a large adaptive cap for Claude 4.6 chat-review', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(
      streamArgs({
        model: 'claude-sonnet-4-6',
        feature: 'chat-review',
      }),
    );

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      max_tokens: number;
      temperature?: number;
      thinking?: unknown;
      output_config?: unknown;
    };

    expect(body.max_tokens).toBe(16000);
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  it('keeps max_tokens for other features unchanged', () => {
    expect(MAX_TOKENS).toEqual({
      'fast-reply': 800,
      'improve-draft': 800,
      'help-me': 1200,
      'fan-summary': 8192,
      'chat-review': 1600,
      'ping': 800,
      'hi-greeting': 800,
    });
  });

  it('streams text deltas and reports cumulative usage metrics', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":40,"cache_read_input_tokens":0,"output_tokens":3,"cache_creation":{"ephemeral_1h_input_tokens":20}}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"input_tokens":120,"cache_creation_input_tokens":40,"cache_read_input_tokens":55,"output_tokens":9,"cache_creation":{"ephemeral_5m_input_tokens":20}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();
    const onText = vi.fn();
    const onUsage = vi.fn();
    const onProgress = vi.fn();

    const rawText = await client.streamMessage(streamArgs({ onText, onUsage, onProgress }));

    expect(rawText).toBe('Hello there');
    expect(onText).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onText).toHaveBeenNthCalledWith(2, ' there');
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onUsage).toHaveBeenNthCalledWith(1, {
      input_tokens: 120,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 0,
      output_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 20,
      },
    });
    expect(onUsage).toHaveBeenNthCalledWith(2, {
      input_tokens: 120,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 55,
      output_tokens: 9,
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 20,
      },
    });
  });
});
