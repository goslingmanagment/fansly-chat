import { describe, expect, it, vi } from 'vitest';
import { ChatGooseError } from '../src/shared/errors.js';
import { LlmClient } from '../src/background/llm-client.js';

function streamArgs(overrides?: Record<string, unknown>) {
  return {
    settings: {
      claudeApiKey: 'sk-ant-test',
      openRouterApiKey: 'sk-or-v1-test',
    },
    model: 'anthropic:claude-sonnet-4-6',
    temperature: 0.65,
    systemBlocks: [{ type: 'text' as const, text: 'system' }],
    userBlocks: [{ type: 'text' as const, text: 'user' }],
    feature: 'fast-reply' as const,
    signal: new AbortController().signal,
    onText: vi.fn(),
    ...overrides,
  };
}

describe('LlmClient provider routing', () => {
  it('routes Anthropic selections to Anthropic with a bare upstream model id', async () => {
    const anthropicClient = { streamMessage: vi.fn(async () => 'Claude') };
    const openRouterClient = { streamMessage: vi.fn(async () => 'OpenRouter') };
    const client = new LlmClient(anthropicClient as never, openRouterClient as never);

    await expect(client.streamMessage(streamArgs())).resolves.toBe('Claude');

    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-6',
      }),
    );
    expect(openRouterClient.streamMessage).not.toHaveBeenCalled();
  });

  it('routes OpenRouter selections to OpenRouter with a bare upstream model id', async () => {
    const anthropicClient = { streamMessage: vi.fn(async () => 'Claude') };
    const openRouterClient = { streamMessage: vi.fn(async () => 'OpenRouter') };
    const client = new LlmClient(anthropicClient as never, openRouterClient as never);

    await expect(
      client.streamMessage(streamArgs({ model: 'openrouter:x-ai/grok-4.3' })),
    ).resolves.toBe('OpenRouter');

    expect(openRouterClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-or-v1-test',
        model: 'x-ai/grok-4.3',
      }),
    );
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('throws provider-aware missing_api_key for OpenRouter selections without a key', async () => {
    const client = new LlmClient(
      { streamMessage: vi.fn(async () => 'Claude') } as never,
      { streamMessage: vi.fn(async () => 'OpenRouter') } as never,
    );

    await expect(
      client.streamMessage(streamArgs({
        model: 'openrouter:x-ai/grok-4.20',
        settings: { claudeApiKey: 'sk-ant-test', openRouterApiKey: '' },
      })),
    ).rejects.toThrow(
      expect.objectContaining({
        key: 'missing_api_key',
        details: { provider: 'openrouter' },
      }) as ChatGooseError,
    );
  });
});
