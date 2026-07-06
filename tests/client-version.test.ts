// Stage 32 Task 5 — the extension's producer identity rides every kernel
// request (stage-11 §2's anticipated extension producer).

import { describe, expect, it, vi } from 'vitest';
import { createKernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import { clientVersionHeaders, extensionClientVersion } from '../src/shared/client-version.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

describe('x-client-version', () => {
  it('names the extension and its manifest version', () => {
    expect(extensionClientVersion()).toMatch(/^chatgoose-extension\/.+$/);
    expect(clientVersionHeaders()).toEqual({
      'x-client-version': extensionClientVersion(),
    });
  });

  it('rides kernel feature requests', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      calls.push(init);
      return new Response(
        'event: ai\ndata: {"type":"done","stopReason":"end_turn"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const gateway = createKernelFeatureGateway(fetchMock as unknown as typeof fetch);
    await gateway.streamFeature(
      {
        ...createDefaultSettings(),
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
      },
      {
        feature: 'fast-reply',
        clientRequestId: '11111111-1111-4111-8111-111111111111',
        pageLabel: 'creator-fs',
        conversationRef: 'fan-1',
        clientContext: {
          transcript: '[10:00] Fan: hey',
          messageCount: 3,
          fanDisplayName: 'Fan',
          fanSpendingData: '',
          fanSubscriptionData: '',
        },
      },
      { onText: () => {} },
      new AbortController().signal,
    );
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers['x-client-version']).toMatch(/^chatgoose-extension\//);
  });
});
