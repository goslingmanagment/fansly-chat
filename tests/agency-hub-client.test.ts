import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgencyHubClient } from '../src/background/agency-hub-client.js';
import { KERNEL_CONTRACT_HASH } from '@kernel/sdk';
import vendorManifest from '../vendor/kernel-sdk/kernel-sdk.vendor.json';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { Settings } from '../src/shared/types.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSettings(overrides: Partial<ReturnType<typeof createDefaultSettings>> = {}) {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'http://localhost:3000',
    agencyHubApiKey: 'hub-key',
    agencyHubDeviceToken: '',
    ...overrides,
  };
}

/** Contract-valid page row (the SDK validates responses since Stage 32). */
function hubPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    label: 'creator-fs',
    platform: 'fansly',
    modelSlug: 'creator',
    modelName: 'Creator',
    username: 'creator',
    displayName: null,
    followerCount: { value: null, available: false },
    subscriberCount: { value: null, available: false },
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
    ...overrides,
  };
}

function topSpendersPayload() {
  return {
    window: 'lifetime',
    builtAt: '2026-07-05T00:00:00.000Z',
    fanCount: 1,
    source: {
      streamState: 'ramped',
      lastSyncedAt: '2026-07-05T01:00:00.000Z',
      consecutiveFailures: 2,
    },
    entries: [
      {
        platformUserId: 'fan-1',
        username: 'alice',
        displayName: 'Alice',
        grossMills: 123_000,
        netMills: 98_400,
        currency: 'USD',
        observedAt: '2026-07-05T00:00:00.000Z',
      },
    ],
  };
}

function voiceNotePayload() {
  return {
    voiceNoteId: 42,
    state: 'queued',
    scriptChars: 12,
    billed: null,
    audioSha256: null,
    audioBytesLen: null,
    createdAt: '2026-07-19T10:00:00.000Z',
  };
}

function makeUsageEvent(index = 1) {
  return {
    clientEventId: `event-${index}`,
    feature: 'fast-reply' as const,
    model: 'claude-sonnet-4-6',
    inputTokens: 120 + index,
    outputTokens: 20 + index,
    cacheWriteTokens: 10,
    cacheReadTokens: 5,
    conversationId: `group-${index}`,
    durationMs: 450,
    isCacheHit: false,
    isRegeneration: false,
    completedAt: '2026-04-04T00:00:00.000Z',
  };
}

describe('AgencyHubClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the typed voice create/status operations', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        voiceNotePayload(),
        init?.method === 'POST' ? 202 : 200,
      );
    });
    vi.stubGlobal('browser', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.createVoiceNote(
      makeSettings(),
      'creator-fs',
      {
        clientRequestId: '11111111-1111-4111-8111-111111111111',
        conversationRef: 'fan-1',
        sourceGenerationRef: 'generation-1',
        script: '[warmly] Hello',
      },
      new AbortController().signal,
    )).resolves.toEqual(voiceNotePayload());
    await expect(client.getVoiceNoteStatus(
      makeSettings(),
      'creator-fs',
      42,
      new AbortController().signal,
    )).resolves.toEqual(voiceNotePayload());

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/v1/pages/creator-fs/voice-notes',
      '/api/v1/pages/creator-fs/voice-notes/42',
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      clientRequestId: '11111111-1111-4111-8111-111111111111',
      conversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      script: '[warmly] Hello',
    });
  });

  it('returns audio-helper auth failures for VoiceService to classify', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'Unauthorized',
      message: 'Unauthorized',
      statusCode: 401,
    }, 401));
    vi.stubGlobal('browser', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    const response = await client.fetchVoiceNoteAudio(
      makeSettings(),
      'creator-fs',
      42,
      new AbortController().signal,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized',
      statusCode: 401,
    });
  });

  it('fetches the read-only persona metadata catalog without exposing prompt text', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:3000/api/v1/ai/persona-catalog');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hub-key');
      return jsonResponse({
        personas: [{
          key: 'closer',
          displayName: 'Closer',
          definitionId: 'v1:closer-definition',
          version: 4,
          status: 'active',
          // The generated catalog response schema strips unknown fields, so a
          // buggy server response cannot promote prompt text into client state.
          systemBlock: 'must not leave the SDK boundary',
        }],
      });
    });
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => true) },
    };
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.fetchAiPersonaCatalog(
      makeSettings(),
      new AbortController().signal,
    )).resolves.toEqual([{
      key: 'closer',
      displayName: 'Closer',
      definitionId: 'v1:closer-definition',
      version: 4,
      status: 'active',
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a deleted fan as deleted and an old kernel silence as alive (E70)', async () => {
    // `topSpendersPayload()` deliberately omits `deletedAt` — the contract
    // declares it optional so a kernel deployed before it still validates, and
    // the kernel ships separately from this extension. That silence must mean
    // "alive", never "deleted".
    const fetchMock = vi.fn(async () => jsonResponse({
      ...topSpendersPayload(),
      fanCount: 2,
      entries: [
        ...topSpendersPayload().entries,
        {
          platformUserId: 'fan-gone',
          username: null,
          displayName: null,
          grossMills: 42_000,
          netMills: null,
          currency: 'USD',
          observedAt: '2026-07-05T00:00:00.000Z',
          deletedAt: '2026-07-20T10:00:00.000Z',
        },
      ],
    }));
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    const result = await client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    );

    expect(result.entries.map((entry) => entry.deletedAt)).toEqual([
      null,
      '2026-07-20T10:00:00.000Z',
    ]);
  });

  it('preserves top-spenders source health from the validated SDK response', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.pathname).toBe('/api/v1/pages/creator-fs/top-spenders');
      expect(requestUrl.searchParams.get('window')).toBe('lifetime');
      expect(requestUrl.searchParams.get('limit')).toBe('1000');
      return jsonResponse(topSpendersPayload());
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    const result = await client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    );

    expect(result).toEqual({
      builtAt: '2026-07-05T00:00:00.000Z',
      fanCount: 1,
      source: {
        streamState: 'ramped',
        lastSyncedAt: '2026-07-05T01:00:00.000Z',
        consecutiveFailures: 2,
      },
      entries: [
        {
          platformUserId: 'fan-1',
          username: 'alice',
          displayName: 'Alice',
          grossMills: 123_000,
          // The fixture carries no `deletedAt` (old-kernel shape) and the
          // mapper normalises the absence to «alive» right here.
          deletedAt: null,
        },
      ],
    });
  });

  it('retries exactly once at 500 for the pre-#142 Core limit response', async () => {
    const limits: string[] = [];
    const fetchMock = vi.fn(async (url: URL | string) => {
      const limit = new URL(String(url)).searchParams.get('limit') ?? '';
      limits.push(limit);
      if (limit === '1000') {
        return jsonResponse({
          error: 'Bad Request',
          message: 'querystring/limit Too big: expected number to be <=500',
          statusCode: 400,
        }, 400);
      }
      return jsonResponse(topSpendersPayload());
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    const result = await client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    );

    expect(limits).toEqual(['1000', '500']);
    expect(result.fanCount).toBe(1);
  });

  it('does not retry an unrelated Hub validation error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'Bad Request',
      message: 'querystring/window Invalid string: must match pattern',
      statusCode: 400,
    }, 400));
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    )).rejects.toMatchObject({
      key: 'hub_request_failed',
      details: { status: 400 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a top-spenders auth failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'Unauthorized',
      message: 'Invalid token',
      statusCode: 401,
    }, 401));
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    )).rejects.toMatchObject({ key: 'hub_invalid_api_key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'network failure',
      failure: () => new Error('socket hang up'),
      expected: { message: expect.stringContaining('socket hang up') },
    },
    {
      name: 'parent abort',
      failure: () => new DOMException('Aborted', 'AbortError'),
      expected: { name: 'AbortError' },
    },
  ])('does not retry a top-spenders $name', async ({ failure, expected }) => {
    const fetchMock = vi.fn(async () => {
      throw failure();
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.fetchTopSpenders(
      makeSettings(),
      'creator-fs',
      'lifetime',
      1000,
      new AbortController().signal,
    )).rejects.toMatchObject(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'invalid Hub URL',
      settings: { agencyHubBaseUrl: 'not a url' },
      key: 'hub_invalid_url',
    },
    {
      name: 'missing Hub credential',
      settings: { agencyHubApiKey: '', agencyHubDeviceToken: '' },
      key: 'hub_missing_api_key',
    },
  ])('keeps $name distinct from a page-mapping miss', async ({ settings, key }) => {
    const fetchMock = vi.fn();
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(
      client.resolvePageLabelForUsername(
        makeSettings(settings),
        'creator',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ key });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps missing Hub host permission distinct from a page-mapping miss', async () => {
    const fetchMock = vi.fn();
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => false) },
    };
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(
      client.resolvePageLabelForUsername(
        makeSettings(),
        'creator',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ key: 'hub_missing_permission' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a page-list network failure inside the Hub error domain', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => true) },
    };
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(
      client.resolvePageLabelForUsername(
        makeSettings(),
        'creator',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ key: 'hub_request_failed' });
  });

  it('reads the optional voice-notes capability from the matched assigned page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      hubPage({ capabilities: { voiceNotes: true } }),
    ]));
    vi.stubGlobal('browser', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const client = new AgencyHubClient(fetchMock as typeof fetch);

    await expect(client.resolvePageForUsername(
      makeSettings(),
      'creator',
      new AbortController().signal,
    )).resolves.toEqual({
      pageLabel: 'creator-fs',
      voiceNotesCapable: true,
    });
  });

  it('matches the Fansly page by username and pushes the raw profile body', async () => {
    const permissionsContains = vi.fn(async () => true);
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([
          hubPage({ id: 1, label: 'creator-of', platform: 'onlyfans', username: 'LoraVie' }),
          hubPage({ id: 2, label: 'creator-fs', platform: 'fansly', username: 'LoraVie' }),
        ]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer hub-key',
          'content-type': 'application/json',
        });
        expect(init?.body).toBe(JSON.stringify({ body: '# fan summary' }));
        return jsonResponse({
          version: 3,
          body: '# fan summary',
          source: 'chatmuse',
          createdAt: '2026-03-20T12:00:00.000Z',
          createdByUserId: null,
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: ' @LoraVie ',
      platformUserId: 'fan-1',
      body: '# fan summary',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'pushed',
      reason: 'pushed',
      baseUrl: 'http://localhost:3000',
      pageLabel: 'creator-fs',
    });
    expect(permissionsContains).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer hub-key',
    });
  });

  it('revalidates immediately after deferred page resolution and before profile PUT', async () => {
    const permissionsContains = vi.fn(async () => true);
    let resolvePages: ((value: Response) => void) | null = null;
    let markPagesStarted: (() => void) | null = null;
    const pagesStarted = new Promise<void>((resolve) => {
      markPagesStarted = resolve;
    });
    const fetchMock = vi.fn((url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        markPagesStarted?.();
        return new Promise<Response>((resolve) => {
          resolvePages = resolve;
        });
      }
      throw new Error(`Unexpected irreversible request: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: permissionsContains },
    };
    const beforeCommit = vi.fn(async () => false);
    const client = new AgencyHubClient(fetch);
    const pushing = client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: 'LoraVie',
      platformUserId: 'fan-1',
      body: '# stale summary',
      signal: new AbortController().signal,
      beforeCommit,
    });

    await pagesStarted;
    resolvePages!(jsonResponse([
      hubPage({ id: 2, label: 'creator-fs', username: 'LoraVie' }),
    ]));
    await expect(pushing).resolves.toMatchObject({
      status: 'skipped',
      reason: 'stale_context',
    });
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits AI usage events as a batch', async () => {
    const permissionsContains = vi.fn(async () => true);
    const events = [makeUsageEvent(1), makeUsageEvent(2)];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:3000/api/v1/ai-usage/batch');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer hub-key',
        'content-type': 'application/json',
      });
      expect(init?.body).toBe(JSON.stringify({ events }));
      return jsonResponse({
        receivedCount: 2,
        insertedCount: 2,
        invalidCount: 0,
        dedupedCount: 0,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings(),
      events,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: 'submitted',
      reason: 'submitted',
      baseUrl: 'http://localhost:3000',
      response: {
        receivedCount: 2,
        insertedCount: 2,
        invalidCount: 0,
        dedupedCount: 0,
      },
    });
    expect(permissionsContains).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
  });

  it('accepts a full 100-event AI usage batch', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      expect(body.events).toHaveLength(100);
      return jsonResponse({
        receivedCount: 100,
        insertedCount: 100,
        invalidCount: 0,
        dedupedCount: 0,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings(),
      events: Array.from({ length: 100 }, (_, index) => makeUsageEvent(index + 1)),
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('submitted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips oversized profile bodies before making any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: 'creator',
      platformUserId: 'fan-1',
      body: 'a'.repeat(50_001),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'body_too_large',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when host permission is missing', async () => {
    const permissionsContains = vi.fn(async () => false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: 'creator',
      platformUserId: 'fan-1',
      body: 'summary',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_host_permission',
    });
    expect(permissionsContains).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips AI usage submission when the Hub is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings({ agencyHubBaseUrl: '' }),
      events: [makeUsageEvent()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_base_url',
      baseUrl: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips AI usage submission when host permission is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => false),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings(),
      events: [makeUsageEvent()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_host_permission',
      baseUrl: 'http://localhost:3000',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests the Agency Hub connection by listing visible pages', async () => {
    const permissionsContains = vi.fn(async () => true);
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:3000/api/v1/pages');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer hub-key',
      });
      return jsonResponse([hubPage()]);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.testConnection(
      {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
        agencyHubDeviceToken: '',
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ ok: true });
    expect(permissionsContains).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a coded missing-permission error when live connection testing cannot access the Hub origin', async () => {
    const permissionsContains = vi.fn(async () => false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.testConnection(
      {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
        agencyHubDeviceToken: '',
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_missing_permission',
        code: 'CG-HUB-04',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps unauthorized live connection tests to the invalid Hub key code', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.testConnection(
      {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
        agencyHubDeviceToken: '',
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_invalid_api_key',
        code: 'CG-HUB-03',
        httpStatus: 401,
      },
    });
    // Copy names the credential that was actually sent (legacy key here) and
    // points at the preferred fix — issuing a device token.
    expect(result.error?.message).toContain('API key');
    expect(result.error?.description).toContain('device token');
    expect(result.error?.serverDetail).toContain('unauthorized');
    // The failure is also visible in the background console.
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Agency Hub'),
      expect.objectContaining({ status: 401 }),
    );
  });

  it('blames the device token, not the key, when the token was the bearer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.testConnection(
      {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
        agencyHubDeviceToken: 'agency_hub_device_stale',
      },
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CG-HUB-03');
    expect(result.error?.message).toContain('device token');
    expect(result.error?.message).not.toContain('API key');
  });

  it('returns a failed result on non-ok or network failures without throwing', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse({ error: 'bad gateway' }, 503);
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: 'creator',
      platformUserId: 'fan-1',
      body: 'summary',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('hub_request_failed');
    expect(result.error).toMatchObject({
      key: 'hub_request_failed',
      code: 'CG-HUB-07',
    });
  });

  it('returns failed for AI usage submission on non-ok responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad gateway' }, 503)));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings(),
      events: [makeUsageEvent()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'hub_request_failed',
      baseUrl: 'http://localhost:3000',
    });
  });

  it('returns failed for AI usage submission on network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket hang up');
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.submitAiUsageBatch({
      settings: makeSettings(),
      events: [makeUsageEvent()],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'Network error calling POST /api/v1/ai-usage/batch: socket hang up',
      baseUrl: 'http://localhost:3000',
    });
  });

  it('binds native-like fetch implementations to globalThis instead of the client instance', async () => {
    const fetchMock = vi.fn(async function (this: typeof globalThis, url: URL | string) {
      expect(this).toBe(globalThis);

      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPage()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        return jsonResponse({
          version: 1,
          body: '# fan summary',
          source: 'chatmuse',
          createdAt: '2026-03-20T12:00:00.000Z',
          createdByUserId: null,
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetchMock as typeof fetch);
    const result = await client.pushFanProfile({
      settings: makeSettings(),
      pageUsername: 'creator',
      platformUserId: 'fan-1',
      body: 'summary',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('pushed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches a cached fan profile by conversation id', async () => {
    const permissionsContains = vi.fn(async () => true);
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPage()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/conversations/group-1/profile') {
        expect(init?.method).toBe('GET');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer hub-key',
        });
        return jsonResponse({
          fan: {
            platform: 'fansly',
            platformUserId: 'fan-1',
            username: 'alice',
            displayName: 'Alice',
            createdAtExternal: null,
            pageAlias: null,
          },
          profile: {
            version: 4,
            body: '# stored fan summary',
            source: 'chatmuse',
            createdAt: '2026-03-20T12:00:00.000Z',
            createdByUserId: 42,
          },
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: permissionsContains,
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: ' creator ',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'fetched',
      reason: 'fetched',
      baseUrl: 'http://localhost:3000',
      pageLabel: 'creator-fs',
      body: '# stored fan summary',
      createdAtMs: Date.parse('2026-03-20T12:00:00.000Z'),
      fanAccountId: 'fan-1',
    });
    expect(permissionsContains).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns not-found when the conversation has no stored profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPage()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/conversations/group-1/profile') {
        return jsonResponse({
          fan: {
            platform: 'fansly',
            platformUserId: 'fan-1',
            username: 'alice',
            displayName: 'Alice',
            createdAtExternal: null,
            pageAlias: null,
          },
          profile: null,
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'not-found',
      reason: 'profile_missing',
      baseUrl: 'http://localhost:3000',
      pageLabel: 'creator-fs',
    });
  });

  it('returns not-found when the conversation lookup responds with 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPage()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/conversations/group-1/profile') {
        return jsonResponse({ error: 'not found' }, 404);
      }
      throw new Error(`Unexpected URL: ${href}`);
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'not-found',
      reason: 'profile_missing',
      baseUrl: 'http://localhost:3000',
      pageLabel: 'creator-fs',
    });
  });

  it('skips conversation profile fetch when the Hub is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings({ agencyHubBaseUrl: '' }),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_base_url',
      baseUrl: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips conversation profile fetch when host permission is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => false),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_host_permission',
      baseUrl: 'http://localhost:3000',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns failed on conversation profile network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        throw new Error('socket hang up');
      }
      throw new Error(`Unexpected URL: ${href}`);
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('socket hang up');
  });

  it('returns failed on conversation profile aborts', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    };

    const controller = new AbortController();
    const client = new AgencyHubClient(fetch);
    const promise = client.fetchFanProfileByConversation({
      settings: makeSettings(),
      pageUsername: 'creator',
      conversationId: 'group-1',
      signal: controller.signal,
    });

    controller.abort();
    const result = await promise;

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'aborted',
      baseUrl: 'http://localhost:3000',
    });
  });

  // Round-10: getRecapStatus was untested; pin the three branches (mirrors the
  // getConversationProfile 404 test) under the discriminated {state} shape.
  const recapSlot = {
    generatedAt: '2026-07-18T12:00:00.000Z',
    ageMs: 1_000,
    transcriptCoverage: 'full-history' as const,
    requestedCount: 3000,
    keptCount: 2900,
  };
  const recapPersonaDefinitionId = 'v1:persona-one-definition';

  it('getRecapStatus: returns state ok with the slots when the Hub answers', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).startsWith('http://localhost:3000/api/v1/ai/recap-status')) {
        return jsonResponse({ full: recapSlot, short: null });
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => true) },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.getRecapStatus(
      makeSettings(),
      {
        pageLabel: 'creator-fs',
        conversationRef: 'group-1',
        fanRef: 'fan-1',
        personaDefinitionId: recapPersonaDefinitionId,
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ state: 'ok', full: recapSlot, short: null });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get('personaDefinitionId')).toBe(recapPersonaDefinitionId);
  });

  it('getRecapStatus: maps a 404 to UNAVAILABLE (endpoint unreadable, not confirmed-no-recap)', async () => {
    // Round-11 P1: a 404 only proves the status could not be read (old Hub / page
    // deleted mid-flight); only a valid 200 can confirm empty slots.
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      if (String(url).startsWith('http://localhost:3000/api/v1/ai/recap-status')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => true) },
    };

    const client = new AgencyHubClient(fetch);
    const result = await client.getRecapStatus(
      makeSettings(),
      {
        pageLabel: 'creator-fs',
        conversationRef: 'group-1',
        fanRef: null,
        personaDefinitionId: recapPersonaDefinitionId,
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('getRecapStatus: rethrows a non-404 Hub failure so the caller reports unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      if (String(url).startsWith('http://localhost:3000/api/v1/ai/recap-status')) {
        return jsonResponse({ error: 'server error' }, 500);
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    }));
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => true) },
    };

    const client = new AgencyHubClient(fetch);
    await expect(
      client.getRecapStatus(
        makeSettings(),
        {
          pageLabel: 'creator-fs',
          conversationRef: 'group-1',
          fanRef: null,
          personaDefinitionId: recapPersonaDefinitionId,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('getRecapStatus: returns unavailable when the Hub is not configured / lacks host permission', async () => {
    (globalThis as Record<string, unknown>).browser = {
      permissions: { contains: vi.fn(async () => false) },
    };
    const fetchMock = vi.fn();
    const client = new AgencyHubClient(fetchMock as unknown as typeof fetch);
    const result = await client.getRecapStatus(
      makeSettings(),
      {
        pageLabel: 'creator-fs',
        conversationRef: 'group-1',
        fanRef: null,
        personaDefinitionId: recapPersonaDefinitionId,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ state: 'unavailable', full: null, short: null });
    // Never even hit the network without permission.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const HUB: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'> = {
  agencyHubBaseUrl: 'https://hub.example',
  agencyHubApiKey: '',
  agencyHubDeviceToken: 'agency_hub_device_abc',
};

function healthBody(status: 'ok' | 'degraded', latencyMs: number | null) {
  return {
    status,
    timestamp: '2026-07-17T00:00:00.000Z',
    contractHash: KERNEL_CONTRACT_HASH,
    capabilities: [],
    checks: {
      api: { status: 'ok' },
      database: { status: status === 'ok' ? 'ok' : 'error', latencyMs, error: null },
    },
  };
}

// checkHealth/checkIdentity dereference the bare `browser` global inside
// hasHostPermission BEFORE the try, and vitest has no setupFiles shim, so every
// test in this file stages `globalThis.browser` by hand (see the existing
// resolvePageLabelForUsername/testConnection cases). Grant by default; the
// no_permission cases flip `contains` to false.
function stubBrowserPermission(granted: boolean): void {
  (globalThis as Record<string, unknown>).browser = {
    permissions: { contains: vi.fn(async () => granted) },
  };
}

describe('AgencyHubClient.checkHealth', () => {
  beforeEach(() => stubBrowserPermission(true));
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('reports UP from a 200 body, stamped with the vendored SDK identity', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('ok', 12), 200));
    const result = await client.checkHealth(HUB, new AbortController().signal);
    expect(result).toEqual({
      ok: true,
      status: 'ok',
      dbLatencyMs: 12,
      contractHash: KERNEL_CONTRACT_HASH,
      sdkContractHash: KERNEL_CONTRACT_HASH,
      // The vendor pin's provenance — the ONLY SDK identity the cabinet shows.
      sdkSourceCommit: vendorManifest.sourceCommit,
    });
  });

  it('reads DEGRADED from a 503 body via raw (the typed client would throw first)', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('degraded', null), 503));
    const result = await client.checkHealth(HUB, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, status: 'degraded', dbLatencyMs: null });
  });

  it('is unreachable on a network throw', async () => {
    const client = new AgencyHubClient(async () => {
      throw new TypeError('network down');
    });
    expect(await client.checkHealth(HUB, new AbortController().signal))
      .toEqual({ ok: false, reason: 'unreachable' });
  });

  it('needs a base URL', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('ok', 1), 200));
    expect(await client.checkHealth({ ...HUB, agencyHubBaseUrl: '' }, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_base_url' });
  });

  it('reports no_permission when the hub origin is not granted', async () => {
    stubBrowserPermission(false);
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('ok', 1), 200));
    expect(await client.checkHealth(HUB, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_permission' });
  });
});

describe('AgencyHubClient.checkIdentity', () => {
  beforeEach(() => stubBrowserPermission(true));
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).browser;
  });

  function meBody() {
    return {
      authMethod: 'device_token',
      user: {
        id: 1,
        username: 'lilly-chatter',
        role: 'chatter',
        mustChangePassword: false,
        assignedPages: [
          { id: 3, label: 'Lilly', platform: 'fansly', modelSlug: 'lilly', modelName: 'Lilly' },
        ],
      },
    };
  }

  it('returns AUTH identity from /auth/me', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity(HUB, new AbortController().signal))
      .toEqual({ ok: true, username: 'lilly-chatter', role: 'chatter', pages: ['Lilly'] });
  });

  it('maps 401 to unauthorized', async () => {
    const client = new AgencyHubClient(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    expect(await client.checkIdentity(HUB, new AbortController().signal))
      .toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('reports no_credential with no bearer', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity(
      { ...HUB, agencyHubDeviceToken: '', agencyHubApiKey: '' },
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'no_credential' });
  });

  it('reports no_base_url — NOT no_credential — when a bearer is present but the address is blank', async () => {
    // A credential with no hub address is a MISSING-ADDRESS state, not a bad
    // credential; conflating them paints a false red «нет credential».
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity({ ...HUB, agencyHubBaseUrl: '' }, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_base_url' });
  });

  it('propagates no_permission distinctly (never folded into unreachable)', async () => {
    stubBrowserPermission(false);
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity(HUB, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_permission' });
  });
});

describe('AgencyHubClient.revokeDeviceToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('returns "revoked" on a 200 body', async () => {
    const fetchImpl = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
    const outcome = await client.revokeDeviceToken(
      { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
      new AbortController().signal,
    );
    expect(outcome).toBe('revoked');
    // The DELETE bearer is the device token itself, never a key.
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('maps 401 to "already-invalid" (token already dead)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Unauthorized', message: 'x', statusCode: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
    const outcome = await client.revokeDeviceToken(
      { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
      new AbortController().signal,
    );
    expect(outcome).toBe('already-invalid');
  });

  it('returns "already-invalid" when there is no token to revoke', async () => {
    const fetchImpl = vi.fn();
    const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
    const outcome = await client.revokeDeviceToken(
      { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: '' },
      new AbortController().signal,
    );
    expect(outcome).toBe('already-invalid');
    expect(fetchImpl).not.toHaveBeenCalled(); // nothing sent — no request without a token
  });

  it('THROWS when the token is present but the base URL is cleared (unreachable, NOT already-invalid)', async () => {
    const fetchImpl = vi.fn();
    const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
    // Token still live server-side, no address to revoke it → the caller must
    // report 'unreachable' and wipe locally; it must never claim a 401 the hub
    // never returned.
    await expect(client.revokeDeviceToken(
      { agencyHubBaseUrl: '', agencyHubDeviceToken: 'agency_hub_device_abc' },
      new AbortController().signal,
    )).rejects.toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled(); // no request without a base URL
  });

  it('throws on a network failure (the caller maps it to unreachable)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
    await expect(client.revokeDeviceToken(
      { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
      new AbortController().signal,
    )).rejects.toBeTruthy();
  });
});
