// Stage 32 Task 3 — the kernel feature lane adapter: refs + clientContext on
// the wire, frame fan-out, gate-message mapping, fail-closed termination.

import { describe, expect, it, vi } from 'vitest';
import { routeSchemas } from '@kernel/sdk';
import { createKernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import { resetHealedBearerMemo } from '../src/background/hub-custody.js';
import type { KernelFeatureRequest } from '../src/background/kernel-feature-gateway.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { resolveAbortChatGooseError } from '../src/background/operation-utils.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function settings() {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'http://localhost:3000',
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
        // E168: the transcript is UTC with day lines, and Core is told so.
        transcriptClock: 'utc',
        messageCount: 12,
        fanDisplayName: 'Charles',
      },
    });
    expect(routeSchemas.aiFeatureStream.body!.safeParse(body).success).toBe(true);
    // Device token preferred over the legacy key (dual-acceptance).
    expect((calls[0]!.init?.headers as Record<string, string>).authorization)
      .toBe('Bearer agency_hub_device_x');
  });

  it('threads coach body fields and returns presetQuestion from meta', async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const attachedRecaps = {
      full: { generatedAt: '2026-07-19T12:00:00.000Z', ageMs: 60_000 },
      short: null,
    };
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push({ init });
      return sseResponse([
        {
          ...META,
          feature: 'coach-chat',
          attachedRecaps,
          presetQuestion: 'Разбери текущую ситуацию',
        },
        { type: 'content_delta', text: 'ok' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const metas: unknown[] = [];
    await gateway.streamFeature(settings(), request({
      feature: 'coach-chat',
      conversationRef: 'group-1',
      fanRef: 'fan-1',
      preset: 'situation',
      coachHistory: [{ question: 'earlier?', answer: 'earlier advice' }],
      clientContext: {
        transcript: '[10:00] Fan: hey',
        messageCount: 5,
        fanDisplayName: 'Charles',
        fanSpendingData: '',
        fanSubscriptionData: '',
        transcriptCoverage: 'full-history',
      },
    }), {
      onText: () => {},
      onMeta: (meta) => metas.push(meta),
    }, new AbortController().signal);

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      conversationRef: 'group-1',
      fanRef: 'fan-1',
      preset: 'situation',
      coachHistory: [{ question: 'earlier?', answer: 'earlier advice' }],
      clientContext: { transcriptCoverage: 'full-history' },
    });
    // summaryMode is coach-irrelevant and must not leak onto a coach body.
    expect(body).not.toHaveProperty('summaryMode');
    expect(body).not.toHaveProperty('chatterQuestion');
    expect(metas).toEqual([expect.objectContaining({
      attachedRecaps,
      presetQuestion: 'Разбери текущую ситуацию',
    })]);
  });

  it('threads bounded ping silence context onto the SDK request body', async () => {
    const calls: Array<{ init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push({ init });
      return sseResponse([
        { ...META, feature: 'ping' },
        { type: 'content_delta', text: 'miss you' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);

    await gateway.streamFeature(settings(), request({
      feature: 'ping',
      clientContext: {
        transcript: '[10:00] Fan: hey',
        messageCount: 4,
        fanDisplayName: 'Charles',
        fanSpendingData: '',
        fanSubscriptionData: '',
        pingSegment: 'segment-a',
        fanSilenceDays: 12,
      },
    }), { onText: () => {} }, new AbortController().signal);

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      clientContext: {
        pingSegment: 'segment-a',
        fanSilenceDays: 12,
      },
    });
  });

  it('sends the unified Hi contract for hi-greeting and keeps it away from every other feature', async () => {
    const greeting = {
      variantCount: 3 as const,
      fanRef: 'fan-1',
      clientContext: {
        transcript: '[10:00] Model: [Automatic / mass message] welcome\n[10:01] Fan: hey',
        messageCount: 2,
        fanDisplayName: 'Charles',
        fanUsername: 'charles77',
        fanAvatarUrl: 'https://cdn3.fansly.com/a.jpg',
        personalMessageCount: 1,
        fanSpendingData: '',
        fanSubscriptionData: '',
      },
    };
    const bodyFor = async (feature: KernelFeatureRequest['feature']): Promise<Record<string, unknown>> => {
      const calls: Array<{ init: RequestInit | undefined }> = [];
      const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
        calls.push({ init });
        return sseResponse([{ ...META, feature }, { type: 'content_delta', text: 'hey' }, { type: 'done', stopReason: 'end_turn' }]);
      });
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      await gateway.streamFeature(settings(), request({ feature, replyTone: undefined, ...greeting }), { onText: () => {} }, new AbortController().signal);
      return JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    };

    const hi = await bodyFor('hi-greeting');
    expect(hi).toMatchObject({
      variantCount: 3,
      clientContext: { fanUsername: 'charles77', fanAvatarUrl: 'https://cdn3.fansly.com/a.jpg', personalMessageCount: 1, messageCount: 2 },
    });
    // The deprecated alias is for released clients only; this one never sends it.
    expect(hi).not.toHaveProperty('greetingMode');
    // The vendored Core contract takes exactly this body.
    expect(routeSchemas.aiFeatureStream.body!.safeParse(hi).success).toBe(true);

    // Core answers 400 to the greeting fields on another feature; the
    // personal count rides Ping too (the hub's Ping gate, 2026-10-21).
    const ping = await bodyFor('ping');
    expect(ping).not.toHaveProperty('variantCount');
    for (const field of ['fanUsername', 'fanAvatarUrl']) {
      expect(ping.clientContext).not.toHaveProperty(field);
    }
    expect(ping.clientContext).toMatchObject({ personalMessageCount: 1 });
    const reply = await bodyFor('fast-reply');
    for (const field of ['fanUsername', 'fanAvatarUrl', 'personalMessageCount']) {
      expect(reply.clientContext).not.toHaveProperty(field);
    }
  });

  it('sends the fan\'s photos on Reply, Fix and Coach only, in the shape Core takes', async () => {
    const liveImages = [{
      platformMessageId: '900',
      mediaId: '55',
      sentAt: '2026-10-22T06:01:00.000Z',
      mediaType: 'image/jpeg' as const,
      data: 'AAAA',
    }];
    const bodyFor = async (feature: KernelFeatureRequest['feature']): Promise<Record<string, unknown>> => {
      const calls: Array<{ init: RequestInit | undefined }> = [];
      const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
        calls.push({ init });
        return sseResponse([{ ...META, feature }, { type: 'content_delta', text: 'hey' }, { type: 'done', stopReason: 'end_turn' }]);
      });
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      await gateway.streamFeature(settings(), request({ feature, liveImages }), { onText: () => {} }, new AbortController().signal);
      return JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    };
    const reply = await bodyFor('fast-reply');
    expect(reply.liveImages).toEqual(liveImages);
    expect(routeSchemas.aiFeatureStream.body!.safeParse(reply).success).toBe(true);
    expect(await bodyFor('help-me')).not.toHaveProperty('liveImages');
  });

  it('sends summaryMode only for a short recap; a full recap omits it', async () => {
    const bodyFor = async (summaryMode: 'short' | undefined): Promise<Record<string, unknown>> => {
      const calls: Array<{ init: RequestInit | undefined }> = [];
      const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
        calls.push({ init });
        return sseResponse([META, { type: 'content_delta', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]);
      });
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      await gateway.streamFeature(settings(), request({
        feature: 'fan-summary',
        conversationRef: 'group-1',
        fanRef: 'fan-1',
        ...(summaryMode ? { summaryMode } : {}),
      }), { onText: () => {} }, new AbortController().signal);
      return JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    };

    expect(await bodyFor('short')).toMatchObject({ summaryMode: 'short', fanRef: 'fan-1' });
    expect(await bodyFor(undefined)).not.toHaveProperty('summaryMode');
  });

  it('maps real pre-Coach validation and structured unknown-feature errors to newer Hub', async () => {
    const failWith = async (payload: object, status: number): Promise<ChatGooseError> => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }));
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      try {
        await gateway.streamFeature(settings(), request({ feature: 'coach-chat' }), { onText: () => {} }, new AbortController().signal);
        throw new Error('expected a throw');
      } catch (error) {
        if (error instanceof ChatGooseError) return error;
        throw error;
      }
    };

    const gated = await failWith({ error: 'unknown_ai_feature', message: 'feature not found', statusCode: 404 }, 404);
    expect(gated.key).toBe('coach_requires_newer_hub');
    expect(gated.code).toBe('CG-HUB-11');
    // A real pre-Coach Core rejects the new strict body before feature dispatch,
    // so its response is Fastify's generic validation 400, not the later 404.
    const legacyValidation = await failWith({
      error: 'Bad Request',
      message: 'body/clientContext Unrecognized key: "transcriptCoverage", body/ Unrecognized keys: "chatterQuestion", "coachHistory"',
      statusCode: 400,
    }, 400);
    expect(legacyValidation.key).toBe('coach_requires_newer_hub');
    // A generic 404 (missing/unauthorized page) must NOT be relabelled.
    const generic = await failWith({ error: 'not_found', message: 'no such page', statusCode: 404 }, 404);
    expect(generic.key).toBe('hub_request_failed');
    // Nor may an unrelated current-Hub Coach validation error be relabelled.
    const currentValidation = await failWith({
      error: 'Bad Request',
      message: 'body/clientContext/messageCount Invalid input: expected int',
      statusCode: 400,
    }, 400);
    expect(currentValidation.key).toBe('hub_request_failed');
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
    const gateByCode = async (code: string, feature: KernelFeatureRequest['feature'] = 'fast-reply'): Promise<ChatGooseError> => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: code, message: 'reworded upstream', statusCode: 400 }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }));
      const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
      try {
        await gateway.streamFeature(settings(), request({ feature }), { onText: () => {} }, new AbortController().signal);
        throw new Error('expected a throw');
      } catch (error) {
        if (error instanceof ChatGooseError) return error;
        throw error;
      }
    };

    expect((await gateByCode('gate_min_messages')).key).toBe('not_enough_history');
    expect((await gateByCode('gate_min_messages', 'ping')).key).toBe('ping_too_few_messages');
    expect((await gateByCode('gate_hi_greeting_limit')).key).toBe('hi_too_many_messages');
    expect((await gateByCode('gate_ping_active')).key).toBe('ping_blocked');
    expect((await gateByCode('gate_draft_required')).key).toBe('unknown_error');
  });

  it('maps quota/auth failures and fails closed with a dedicated truncated-stream card', async () => {
    // §4.5 needs real custody to answer: the card says «сессия завершена» only
    // when this device was actually signed out, so the stored credential has to
    // be the one the request carried.
    const store: Record<string, unknown> = { agencyHubDeviceToken: 'agency_hub_device_x' };
    (globalThis as Record<string, unknown>).browser = {
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            if (keys === null || keys === undefined) return { ...store };
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
          },
          set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
          remove: async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
          },
        },
      },
    };
    resetHealedBearerMemo();

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
    // A bare 401 fails closed: the sign-in stays, the chatter gets the honest
    // «Agency Hub отклонил вход» card (§4.5).
    expect((await failWith(new Response('{"message":"nope"}', { status: 401 }))).key).toBe('hub_unauthorized');
    // …a 401 the kernel gave a reason for signs this device out and says so.
    const revoked = await failWith(new Response(
      '{"error":"Unauthorized","message":"revoked","statusCode":401,"reason":"token_revoked"}',
      { status: 401 },
    ));
    expect(revoked.key).toBe('hub_session_ended');
    expect(revoked.code).toBe('CG-HUB-19');
    const expired = await failWith(new Response(
      '{"error":"Unauthorized","message":"expired","statusCode":401,"reason":"token_expired"}',
      { status: 401 },
    ));
    expect(expired.key).toBe('hub_session_ended');
    // A reason this client does not act on is NOT self-healed.
    const unknownReason = await failWith(new Response(
      '{"error":"Unauthorized","message":"?","statusCode":401,"reason":"user_disabled"}',
      { status: 401 },
    ));
    expect(unknownReason.key).toBe('hub_unauthorized');
    // The device WAS signed out — once, by the first named 401 above.
    expect(store.agencyHubDeviceToken).toBe('');

    // …and a named 401 for a bearer that is no longer the stored one heals
    // nothing, so it must NOT claim the session ended: a newer sign-in is live.
    resetHealedBearerMemo();
    store.agencyHubDeviceToken = 'agency_hub_device_FRESH';
    const staleRejection = await failWith(new Response(
      '{"error":"Unauthorized","message":"revoked","statusCode":401,"reason":"token_revoked"}',
      { status: 401 },
    ));
    expect(staleRejection.key).toBe('hub_unauthorized');
    expect(store.agencyHubDeviceToken).toBe('agency_hub_device_FRESH');

    delete (globalThis as Record<string, unknown>).browser;

    // Missing terminal frame = truncated generation → never presented as done.
    const truncated = await failWith(sseResponse([META, { type: 'content_delta', text: 'partial' }]));
    expect(truncated.key).toBe('hub_stream_truncated');
    expect(truncated.code).toBe('CG-HUB-16');
    expect(truncated.message).toContain('without completing');
  });

  it.each([
    ['provider_billing', 'hub_provider_billing', 'CG-HUB-12', null],
    ['provider_auth', 'hub_provider_auth', 'CG-HUB-13', null],
    ['provider_rate_limited', 'hub_provider_rate_limited', 'CG-HUB-14', 45_000],
    ['provider_unavailable', 'hub_provider_unavailable', 'CG-HUB-15', null],
    ['provider_proxy_unreachable', 'hub_provider_failed', 'CG-HUB-10', null],
    ['provider_stream_failed', 'hub_provider_failed', 'CG-HUB-10', null],
  ] as const)(
    'exact-matches %s before the provider-prefix fallback',
    async (frameCode, expectedKey, expectedCardCode, retryAfterMs) => {
      const before = Date.now();
      const gateway = createKernelFeatureGateway(vi.fn(async () => sseResponse([
        META,
        { type: 'content_delta', text: 'partial ' },
        {
          type: 'error',
          code: frameCode,
          message: 'Static kernel provider failure',
          retryAfterMs,
        },
      ])) as unknown as typeof fetch);

      let caught: unknown;
      try {
        await gateway.streamFeature(
          settings(),
          request(),
          { onText: () => {} },
          new AbortController().signal,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ChatGooseError);
      const error = caught as ChatGooseError;
      expect(error.key).toBe(expectedKey);
      expect(error.code).toBe(expectedCardCode);
      expect(error.message).not.toContain('without completing');
      expect(error.details?.responseSnippet).toBe(
        `${frameCode}: Static kernel provider failure`,
      );
      if (retryAfterMs === null) {
        expect(error.retryAfterMs).toBeUndefined();
        expect(error.retryAtMs).toBeUndefined();
      } else {
        expect(error.retryAfterMs).toBe(retryAfterMs);
        expect(error.retryAtMs).toBeGreaterThanOrEqual(before + retryAfterMs);
        expect(error.retryAtMs).toBeLessThanOrEqual(Date.now() + retryAfterMs);
      }
    },
  );

  it('keeps an unknown future provider code on the CG-HUB-10 prefix fallback', async () => {
    const gateway = createKernelFeatureGateway(vi.fn(async () => sseResponse([
      META,
      {
        type: 'error',
        code: 'provider_future_transport_failure',
        message: 'Future static provider failure',
        retryAfterMs: null,
      },
    ])) as unknown as typeof fetch);

    let caught: unknown;
    try {
      await gateway.streamFeature(settings(), request(), { onText: () => {} }, new AbortController().signal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChatGooseError);
    const error = caught as ChatGooseError;
    // The frame's cause must survive — never the generic truncation wording.
    expect(error.key).toBe('hub_provider_failed');
    expect(error.code).toBe('CG-HUB-10');
    expect(error.message).not.toContain('without completing');
    expect(error.details?.responseSnippet).toBe(
      'provider_future_transport_failure: Future static provider failure',
    );
  });

  it('maps provider_output_empty to ai_output_unusable, not an infrastructure failure', async () => {
    const gateway = createKernelFeatureGateway(vi.fn(async () => sseResponse([
      META,
      {
        type: 'error',
        code: 'provider_output_empty',
        message: 'AI provider returned no usable output',
        retryAfterMs: null,
      },
    ])) as unknown as typeof fetch);

    await expect(gateway.streamFeature(
      settings(),
      request(),
      { onText: () => {} },
      new AbortController().signal,
    )).rejects.toMatchObject({
      key: 'ai_output_unusable',
      details: {
        responseSnippet: 'provider_output_empty: AI provider returned no usable output',
      },
    });
  });

  it('maps an unknown error frame code to hub_request_failed, still carrying the detail', async () => {
    const gateway = createKernelFeatureGateway(vi.fn(async () => sseResponse([
      META,
      {
        type: 'error',
        code: 'context_overflow',
        message: 'prompt too large',
        retryAfterMs: 12_000,
      },
    ])) as unknown as typeof fetch);

    let caught: unknown;
    try {
      await gateway.streamFeature(settings(), request(), { onText: () => {} }, new AbortController().signal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChatGooseError);
    const error = caught as ChatGooseError;
    expect(error.key).toBe('hub_request_failed');
    expect(error.details?.responseSnippet).toBe('context_overflow: prompt too large');
    expect(error.retryAfterMs).toBe(12_000);
  });

  it('sends the expected definition and accepts text only after the exact meta echo', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const definitionId = 'v1:persona-one-definition';
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push(init);
      return sseResponse([
        { ...META, personaDefinitionId: definitionId },
        { type: 'content_delta', text: 'safe text' },
        { type: 'done', stopReason: 'end_turn' },
      ]);
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const texts: string[] = [];
    const metas: unknown[] = [];

    await expect(gateway.streamFeature(
      settings(),
      request({ expectedPersonaDefinitionId: definitionId }),
      {
        onText: (text) => texts.push(text),
        onMeta: (meta) => metas.push(meta),
      },
      new AbortController().signal,
    )).resolves.toBe('safe text');

    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      expectedPersonaDefinitionId: definitionId,
    });
    expect(texts).toEqual(['safe text']);
    expect(metas).toEqual([expect.objectContaining({ personaDefinitionId: definitionId })]);
  });

  it.each([
    { label: 'missing', metaDefinitionId: undefined },
    { label: 'different', metaDefinitionId: 'v1:persona-two-definition' },
  ])('fails closed before text when the meta definition echo is $label', async ({ metaDefinitionId }) => {
    const refresh = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => sseResponse([
      {
        ...META,
        ...(metaDefinitionId === undefined ? {} : { personaDefinitionId: metaDefinitionId }),
      },
      { type: 'content_delta', text: 'must not escape' },
      { type: 'done', stopReason: 'end_turn' },
    ]));
    const gateway = createKernelFeatureGateway(
      fetchMock as unknown as typeof fetch,
      refresh,
    );
    const onText = vi.fn();

    await expect(gateway.streamFeature(
      settings(),
      request({ expectedPersonaDefinitionId: 'v1:persona-one-definition' }),
      { onText },
      new AbortController().signal,
    )).rejects.toMatchObject({ key: 'chat_changed' });
    expect(onText).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('rejects every non-meta side effect before provenance is established', async () => {
    const refresh = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => sseResponse([
      {
        type: 'debug_input_v1',
        systemBlocks: [{ text: 'must not escape', cache: '1h' }],
        userBlocks: [{ text: 'must not escape either', cache: '5m' }],
        contextManifest: null,
      },
      { ...META, personaDefinitionId: 'v1:persona-one-definition' },
      { type: 'done', stopReason: 'end_turn' },
    ]));
    const gateway = createKernelFeatureGateway(
      fetchMock as unknown as typeof fetch,
      refresh,
    );
    const onDebugInput = vi.fn();
    const onStopReason = vi.fn();

    await expect(gateway.streamFeature(
      settings(),
      request({ expectedPersonaDefinitionId: 'v1:persona-one-definition' }),
      { onText: () => undefined, onDebugInput, onStopReason },
      new AbortController().signal,
    )).rejects.toMatchObject({ key: 'chat_changed' });
    expect(onDebugInput).not.toHaveBeenCalled();
    expect(onStopReason).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('maps a structured definition conflict and schedules a catalog refresh', async () => {
    const refresh = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: 'persona_definition_changed',
      message: 'Persona definition changed',
      statusCode: 409,
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    const gateway = createKernelFeatureGateway(
      fetchMock as unknown as typeof fetch,
      refresh,
    );

    await expect(gateway.streamFeature(
      settings(),
      request({ expectedPersonaDefinitionId: 'v1:persona-one-definition' }),
      { onText: () => undefined },
      new AbortController().signal,
    )).rejects.toMatchObject({ key: 'chat_changed' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledWith();
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

// The abort classification. Proven with a live probe during the 2026-07-28
// audit: the vendored SDK swallows EVERY exception once its own signal is
// aborted (`vendor/kernel-sdk/dist/contracts/sdk-runtime.js`:
// `.catch((error) => { if (abort.signal.aborted) { return; } throw error; })`),
// so `handle.done` RESOLVES on abort. The gateway used to read that as
// `hub_stream_truncated` (CG-HUB-16), which made every LLM-stage timeout
// (llm-ttfb / llm-idle / llm-max-stream) say «Генерация оборвалась» instead of
// «Время ожидания истекло» AND falsely grow the daily «Ошибки генераций (Hub)»
// counter (ops-daily counts CG-HUB-* prefixes; CG-NET-02 is not counted).
// What is pinned here is the ORDER: kernel terminal frame → abort → truncation.
// Fail-closed is untouched: every non-`done` path still throws.
describe('kernel feature gateway abort classification', () => {
  /** A scripted SSE body that stays OPEN until the test closes it — the
   * buffered `sseResponse` helper above completes before an abort could ever
   * land. Mirrors real fetch: the body errors when the request signal aborts,
   * while frames already parsed out of a delivered chunk are still dispatched
   * (`parseSseStream` drains its whole buffer before the next `read()`) — that
   * is exactly the teardown race the classification has to survive. */
  function liveSseResponse(signal: AbortSignal | null | undefined): {
    response: Response;
    push: (...frames: object[]) => void;
    close: () => void;
  } {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        signal?.addEventListener('abort', () => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      },
    });
    return {
      response: new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
      push: (...frames: object[]) => {
        controller.enqueue(encoder.encode(
          frames.map((frame) => `event: ai\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
        ));
      },
      close: () => controller.close(),
    };
  }

  /** Wires the gateway to a live SSE body and aborts `cancel` from inside the
   * first `onText` — the deterministic stand-in for an armed LLM timeout (or a
   * chatter cancel) firing mid-stream. */
  function startAgainstLiveStream(cancel: AbortController) {
    let live: ReturnType<typeof liveSseResponse> | null = null;
    const texts: string[] = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      live = liveSseResponse(init?.signal);
      return live.response;
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const streamed = gateway.streamFeature(settings(), request(), {
      onText: (text) => texts.push(text),
    }, cancel.signal);
    // The stream must not reject before the test inspects it.
    const settled = streamed.then(() => null, (error: unknown) => error);
    return {
      texts,
      settled,
      ready: async (): Promise<ReturnType<typeof liveSseResponse>> => {
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        return live!;
      },
    };
  }

  it('re-raises a mid-stream abort as AbortError, never as a truncated stream', async () => {
    const cancel = new AbortController();
    const { texts, settled, ready } = startAgainstLiveStream(cancel);
    const live = await ready();

    live.push(META, { type: 'content_delta', text: 'partial' });
    await vi.waitFor(() => expect(texts).toEqual(['partial']));
    cancel.abort();

    const caught = await settled;
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(caught).not.toBeInstanceOf(ChatGooseError);
    // The consequence this whole fix exists for: only a DOMException named
    // AbortError reaches the honest mapping. An armed timeout becomes
    // CG-NET-02 «Время ожидания истекло» — not a CG-HUB-* card, so the daily
    // Hub-error counter stays untouched.
    expect(resolveAbortChatGooseError(caught, {
      active: true,
      timeoutSignal: cancel.signal,
    })?.key).toBe('timed_out');
  });

  it('still fails closed with hub_stream_truncated when the stream ends without done and without an abort', async () => {
    const cancel = new AbortController();
    const { texts, settled, ready } = startAgainstLiveStream(cancel);
    const live = await ready();

    live.push(META, { type: 'content_delta', text: 'partial' });
    await vi.waitFor(() => expect(texts).toEqual(['partial']));
    live.close();

    const caught = await settled;
    expect(cancel.signal.aborted).toBe(false);
    expect(caught).toBeInstanceOf(ChatGooseError);
    expect(caught).toMatchObject({ key: 'hub_stream_truncated', code: 'CG-HUB-16' });
    expect((caught as ChatGooseError).message).toContain('without completing');
  });

  it('surfaces the kernel terminal error frame even when an abort races the teardown', async () => {
    const cancel = new AbortController();
    let live: ReturnType<typeof liveSseResponse> | null = null;
    const texts: string[] = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      live = liveSseResponse(init?.signal);
      return live.response;
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    const streamed = gateway.streamFeature(settings(), request(), {
      // Abort from inside the delta of the SAME chunk that carries the error
      // frame: the signal is already aborted by the time the frame handler
      // throws, so the SDK swallows the kernel's verdict. Before the capture
      // this surfaced as a bare AbortError/CG-HUB-16 and the real cause (a
      // dead page proxy) was lost.
      onText: (text) => {
        texts.push(text);
        cancel.abort();
      },
    }, cancel.signal);
    const settled = streamed.then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    live!.push(
      META,
      { type: 'content_delta', text: 'partial' },
      {
        type: 'error',
        code: 'provider_stream_failed',
        message: 'Static kernel provider failure',
        retryAfterMs: null,
      },
    );
    live!.close();

    const caught = await settled;
    expect(cancel.signal.aborted).toBe(true);
    expect(caught).toBeInstanceOf(ChatGooseError);
    expect(caught).toMatchObject({ key: 'hub_provider_failed', code: 'CG-HUB-10' });
    expect((caught as ChatGooseError).details?.responseSnippet)
      .toBe('provider_stream_failed: Static kernel provider failure');
    expect((caught as ChatGooseError).message).not.toContain('without completing');
  });
});
