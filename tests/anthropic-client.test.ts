import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatMuseError } from '../src/shared/errors.js';

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
        })
      : null,
  };
  vi.stubGlobal('fetch', vi.fn(async () => response));
  return response;
}

function streamArgs(overrides?: Partial<Parameters<InstanceType<typeof import('../src/background/anthropic-client.js').AnthropicClient>['streamMessage']>[0]>) {
  return {
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-20250514',
    system: 'test',
    user: 'test',
    feature: 'fast-reply' as const,
    signal: new AbortController().signal,
    onText: vi.fn(),
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
});
