import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function streamArgs(overrides?: Partial<Parameters<InstanceType<typeof import('../src/background/anthropic-client.js').AnthropicClient>['streamMessage']>[0]>) {
  return {
    provider: 'anthropic' as const,
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-20250514',
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
    debugEnabled: false,
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
  (globalThis as Record<string, unknown>).browser = {
    permissions: {
      contains: vi.fn(async () => true),
    },
  };
  const mod = await import('../src/background/anthropic-client.js');
  AnthropicClient = mod.AnthropicClient;
});

// ─── Bug 8: Error mapping ───────────────────────────────────────────────

describe('AnthropicClient error mapping', () => {
  it('maps 401 to invalid_api_key', async () => {
    mockFetchResponse(401);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_api_key' }),
    );
  });

  it('maps 403 to invalid_api_key', async () => {
    mockFetchResponse(403);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_api_key' }),
    );
  });

  it('maps 429 to claude_overloaded', async () => {
    mockFetchResponse(429);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'claude_overloaded' }),
    );
  });

  it('maps 500 to claude_overloaded', async () => {
    mockFetchResponse(500);
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'claude_overloaded' }),
    );
  });

  it('maps 400 with not_found_error to model_unavailable', async () => {
    mockFetchResponse(400, {
      error: { type: 'not_found_error', message: 'model not found' },
    });
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'model_unavailable' }),
    );
  });

  it('maps 400 with non-model error to unknown_error, not network_error (Bug 8)', async () => {
    mockFetchResponse(400, {
      error: { type: 'invalid_request_error', message: 'max_tokens: must be positive' },
    });
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'unknown_error' }),
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
      expect.objectContaining({ code: 'unknown_error' }),
    );
  });

  it('maps non-ok response with no body to network_error', async () => {
    // 502 hits the >= 500 check first (claude_overloaded). Use 418 to test the !response.ok fallback.
    const response: Partial<Response> = {
      status: 418,
      ok: false,
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const client = new AnthropicClient();
    await expect(client.streamMessage(streamArgs())).rejects.toThrow(
      expect.objectContaining({ code: 'network_error' }),
    );
  });

  it('classifies Kiro pre-response failures and emits diagnostics when debug mode is enabled', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch sk-aw-live');
    }));
    const client = new AnthropicClient();

    let thrown: unknown;
    try {
      await client.streamMessage(streamArgs({
        provider: 'kiro',
        apiKey: 'sk-aw-test',
        debugEnabled: true,
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'provider_connection_failed',
      provider: 'kiro',
    });
    expect((thrown as Error).message).toContain('Request failed before a response was received');
    expect((thrown as Error).message).not.toContain('sk-aw-live');
    expect(debugSpy).toHaveBeenCalledWith('[ChatMuse] claude request failed', expect.objectContaining({
      provider: 'kiro',
      requestUrl: 'https://api.kiro.cheap/v1/messages',
      requestHost: 'api.kiro.cheap',
      error: expect.objectContaining({
        name: 'TypeError',
        message: 'Failed to fetch [REDACTED]',
      }),
    }));
    debugSpy.mockRestore();
  });

  it('classifies missing host access before surfacing a Kiro fetch failure', async () => {
    (browser.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const client = new AnthropicClient();

    await expect(client.streamMessage(streamArgs({
      provider: 'kiro',
      apiKey: 'sk-aw-test',
    }))).rejects.toThrow(
      expect.objectContaining({ code: 'provider_host_access_missing' }),
    );
  });

  it('attaches response detail for non-ok responses without a streaming body', async () => {
    const response: Partial<Response> = {
      status: 418,
      ok: false,
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const client = new AnthropicClient();

    let thrown: unknown;
    try {
      await client.streamMessage(streamArgs({ provider: 'kiro', apiKey: 'sk-aw-test' }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'network_error',
      provider: 'kiro',
    });
    expect((thrown as Error).message).toContain('HTTP 418');
    expect((thrown as Error).message).toContain('no streaming body');
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    const request = fetchMock.mock.calls[0]?.[1];
    const headers = request?.headers as Record<string, string>;
    const body = JSON.parse(String(request?.body)) as {
      system: unknown;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers).not.toHaveProperty('anthropic-beta');
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

  it('uses the Kiro base URL and omits the direct-browser header', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    await client.streamMessage(streamArgs({ provider: 'kiro', apiKey: 'sk-aw-test' }));

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.kiro.cheap/v1/messages');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('anthropic-dangerous-direct-browser-access');
  });

  it('returns a successful provider connection test result for Kiro', async () => {
    mockFetchResponse(200, undefined, {
      bodyStream: [
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'),
    });
    const client = new AnthropicClient();

    const result = await client.testConnection({
      provider: 'kiro',
      apiKey: 'sk-aw-test',
      model: 'claude-sonnet-4-6',
      debugEnabled: false,
    });

    expect(result).toMatchObject({
      provider: 'kiro',
      requestHost: 'api.kiro.cheap',
      status: 'ready',
      capabilityStatus: 'ready',
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

    const rawText = await client.streamMessage(streamArgs({ onText, onUsage }));

    expect(rawText).toBe('Hello there');
    expect(onText).toHaveBeenNthCalledWith(1, 'Hello');
    expect(onText).toHaveBeenNthCalledWith(2, ' there');
    expect(onUsage).toHaveBeenCalledTimes(2);
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
