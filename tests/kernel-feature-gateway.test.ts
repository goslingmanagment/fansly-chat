// Stage 32 Task 3 — the kernel feature lane adapter: refs + clientContext on
// the wire, frame fan-out, gate-message mapping, fail-closed termination.

import { describe, expect, it, vi } from 'vitest';
import { createKernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { KernelFeatureRequest } from '../src/background/kernel-feature-gateway.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function settings() {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'http://localhost:3000',
    agencyHubApiKey: 'hub-key',
    agencyHubDeviceToken: 'agency_hub_device_x',
  };
}

function request(overrides: Partial<KernelFeatureRequest> = {}): KernelFeatureRequest {
  return {
    feature: 'fast-reply',
    clientRequestId: CLIENT_REQUEST_ID,
    pageLabel: 'creator-fs',
    conversationRef: 'fan-1',
    personaKey: 'builtin:lora',
    replyTone: 'flirty',
    clientContext: {
      transcript: '[10:00] Fan: hey you',
      messageCount: 12,
      fanDisplayName: 'Charles',
      fanSpendingData: 'Total: $42.00',
      fanSubscriptionData: 'Subscribed: yes',
    },
    ...overrides,
  };
}

function sseResponse(frames: object[]): Response {
  const body = frames.map((frame) => `event: ai\ndata: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const META = {
  type: 'meta',
  requestId: '22222222-2222-4222-8222-222222222222',
  clientRequestId: CLIENT_REQUEST_ID,
  feature: 'fast-reply',
  pageLabel: 'creator-fs',
  model: 'anthropic:claude-sonnet-4-6',
  provider: 'anthropic',
  providerResponseId: null,
  quota: { accepted: true, remainingRequestsToday: 10, remainingMicroUsdToday: 1_000_000 },
};

describe('kernel feature gateway', () => {
  it('sends refs + clientContext and fans frames out to the callbacks', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return sseResponse([
        META,
        { type: 'content_delta', text: 'hey ' },
        {
          type: 'usage',
          usage: {
            inputTokens: 10, outputTokens: 4, cacheWriteTokens: 2, cacheReadTokens: 3,
            costMicroUsd: 1234, costApproximate: false,
          },
          providerResponseId: 'msg_1',
          cacheHit: false,
        },
        { type: 'content_delta', text: 'you' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });

    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const texts: string[] = [];
    const metas: unknown[] = [];
    const usages: unknown[] = [];
    const stops: Array<string | null> = [];

    const raw = await gateway.streamFeature(settings(), request(), {
      onText: (text) => texts.push(text),
      onMeta: (meta) => metas.push(meta),
      onUsage: (usage) => usages.push(usage),
      onStopReason: (stop) => stops.push(stop),
    }, new AbortController().signal);

    expect(raw).toBe('hey you');
    expect(texts).toEqual(['hey ', 'you']);
    expect(metas).toEqual([{
      requestId: '22222222-2222-4222-8222-222222222222',
      clientRequestId: CLIENT_REQUEST_ID,
      model: 'anthropic:claude-sonnet-4-6',
    }]);
    expect(usages).toEqual([{
      inputTokens: 10, outputTokens: 4, cacheWriteTokens: 2, cacheReadTokens: 3,
      costMicroUsd: 1234, costApproximate: false,
    }]);
    expect(stops).toEqual(['end_turn']);

    expect(calls[0]!.url).toBe('http://localhost:3000/api/v1/ai/features/fast-reply');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      clientRequestId: CLIENT_REQUEST_ID,
      pageLabel: 'creator-fs',
      platform: 'fansly',
      conversationRef: 'fan-1',
      personaKey: 'builtin:lora',
      replyTone: 'flirty',
      isRegeneration: false,
      clientContext: {
        transcript: '[10:00] Fan: hey you',
        messageCount: 12,
        fanDisplayName: 'Charles',
      },
    });
    // Device token preferred over the legacy key (dual-acceptance).
    expect((calls[0]!.init?.headers as Record<string, string>).authorization)
      .toBe('Bearer agency_hub_device_x');
  });

  it('maps kernel product-gate wordings onto the extension error keys', async () => {
    const gate = async (message: string): Promise<ChatGooseError> => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Bad Request', message, statusCode: 400 }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }));
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      try {
        await gateway.streamFeature(settings(), request(), { onText: () => {} }, new AbortController().signal);
        throw new Error('expected a throw');
      } catch (error) {
        if (error instanceof ChatGooseError) return error;
        throw error;
      }
    };

    expect((await gate('fan-summary requires at least 30 messages in the conversation')).key)
      .toBe('not_enough_history');
    expect((await gate('hi-greeting is only available for conversations with at most 10 messages')).key)
      .toBe('hi_too_many_messages');
    expect((await gate('ping is blocked while the conversation is active')).key)
      .toBe('ping_blocked');
  });

  it('maps kernel gate codes structurally, independent of the message wording (#120)', async () => {
    const gateByCode = async (code: string): Promise<ChatGooseError> => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: code, message: 'reworded upstream', statusCode: 400 }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }));
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      try {
        await gateway.streamFeature(settings(), request(), { onText: () => {} }, new AbortController().signal);
        throw new Error('expected a throw');
      } catch (error) {
        if (error instanceof ChatGooseError) return error;
        throw error;
      }
    };

    expect((await gateByCode('gate_min_messages')).key).toBe('not_enough_history');
    expect((await gateByCode('gate_hi_greeting_limit')).key).toBe('hi_too_many_messages');
    expect((await gateByCode('gate_ping_active')).key).toBe('ping_blocked');
    expect((await gateByCode('gate_draft_required')).key).toBe('unknown_error');
  });

  it('maps quota/provider/auth failures and fails closed on a truncated stream', async () => {
    const failWith = async (response: Response): Promise<ChatGooseError> => {
      const gateway = createKernelFeatureGateway(
        vi.fn(async () => response) as unknown as typeof fetch,
      );
      try {
        await gateway.streamFeature(settings(), request(), { onText: () => {} }, new AbortController().signal);
        throw new Error('expected a throw');
      } catch (error) {
        if (error instanceof ChatGooseError) return error;
        throw error;
      }
    };

    expect((await failWith(new Response('{"message":"quota"}', { status: 429 }))).key).toBe('rate_limited');
    // The daily-cap denial carries code "quota_denied" — its own card, not
    // the transient "try again shortly" rate-limit one (#120).
    const quotaDenied = await failWith(new Response(
      '{"error":"quota_denied","message":"ChatMuse AI gateway daily quota exceeded","statusCode":429}',
      { status: 429 },
    ));
    expect(quotaDenied.key).toBe('hub_quota_exceeded');
    expect(quotaDenied.code).toBe('CG-HUB-09');
    expect((await failWith(new Response('{"message":"down"}', { status: 503 }))).key).toBe('service_unavailable');
    expect((await failWith(new Response('{"message":"nope"}', { status: 401 }))).key).toBe('hub_invalid_api_key');

    // Missing terminal frame = truncated generation → never presented as done.
    const truncated = await failWith(sseResponse([META, { type: 'content_delta', text: 'partial' }]));
    expect(truncated.key).toBe('hub_request_failed');
    expect(truncated.message).toContain('without completing');
  });
});

// E28 — the prompt echo. The capability rides a HEADER, never the body: an old
// kernel ignores an unknown header, so a kernel rollback after a client release
// cannot 400 a generation. And the echo is only ever asked for, never assumed.
describe('kernel feature gateway prompt echo', () => {
  const DEBUG_FRAME = {
    type: 'debug_input_v1',
    systemBlocks: [{ text: 'safety + persona', cache: '1h' }],
    userBlocks: [{ text: '## Fan Dossier\nred Ducati', cache: '5m' }],
    contextManifest: { fanProfile: { version: 2, ageDays: 1 } },
  };

  it('advertises the capability only when asked, and hands the echo to the callback', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push(init);
      return sseResponse([META, DEBUG_FRAME, { type: 'content_delta', text: 'hi' }, { type: 'done', stopReason: 'end_turn' }]);
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const echoes: unknown[] = [];

    await gateway.streamFeature(
      settings(),
      request({ debugPromptEcho: true }),
      { onText: () => undefined, onDebugInput: (input) => echoes.push(input) },
      new AbortController().signal,
    );

    expect(new Headers(calls[0]?.headers).get('x-kernel-ai-capabilities')).toBe('debug-input-v1');
    expect(JSON.parse(String(calls[0]?.body))).not.toHaveProperty('debugPrompt');
    expect(echoes).toEqual([{
      systemBlocks: DEBUG_FRAME.systemBlocks,
      userBlocks: DEBUG_FRAME.userBlocks,
      contextManifest: DEBUG_FRAME.contextManifest,
    }]);
  });

  it('does not advertise the capability when debug mode is off', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push(init);
      return sseResponse([META, { type: 'content_delta', text: 'hi' }, { type: 'done', stopReason: 'end_turn' }]);
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const echoes: unknown[] = [];

    await gateway.streamFeature(
      settings(),
      request(),
      { onText: () => undefined, onDebugInput: (input) => echoes.push(input) },
      new AbortController().signal,
    );

    expect(new Headers(calls[0]?.headers).get('x-kernel-ai-capabilities')).toBeNull();
    expect(echoes).toEqual([]);
  });
});
