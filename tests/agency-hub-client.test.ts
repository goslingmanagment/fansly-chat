import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgencyHubClient } from '../src/background/agency-hub-client.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

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
    ...overrides,
  };
}

describe('AgencyHubClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('matches the Fansly page by username and pushes the raw profile body', async () => {
    const permissionsContains = vi.fn(async () => true);
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([
          { label: 'creator-of', platform: 'onlyfans', username: 'LoraVie' },
          { label: 'creator-fs', platform: 'fansly', username: 'LoraVie' },
        ]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        expect(init?.method).toBe('PUT');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer hub-key',
          'content-type': 'application/json',
        });
        expect(init?.body).toBe(JSON.stringify({ body: '# fan summary' }));
        return jsonResponse({ version: 3 });
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

  it('tests the Agency Hub connection by listing visible pages', async () => {
    const permissionsContains = vi.fn(async () => true);
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:3000/api/v1/pages');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer hub-key',
      });
      return jsonResponse([
        { label: 'creator-fs', platform: 'fansly', username: 'creator' },
      ]);
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
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_missing_permission',
        code: 'CM-HUB-04',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps unauthorized live connection tests to the invalid Hub key code', async () => {
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
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_invalid_api_key',
        code: 'CM-HUB-03',
      },
    });
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
      code: 'CM-HUB-07',
    });
  });

  it('binds native-like fetch implementations to globalThis instead of the client instance', async () => {
    const fetchMock = vi.fn(async function (this: typeof globalThis, url: URL | string) {
      expect(this).toBe(globalThis);

      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([
          { label: 'creator-fs', platform: 'fansly', username: 'creator' },
        ]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        return jsonResponse({ version: 1 });
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
        return jsonResponse([
          { label: 'creator-fs', platform: 'fansly', username: 'creator' },
        ]);
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
        return jsonResponse([
          { label: 'creator-fs', platform: 'fansly', username: 'creator' },
        ]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/conversations/group-1/profile') {
        return jsonResponse({
          fan: {
            platform: 'fansly',
            platformUserId: 'fan-1',
            username: 'alice',
            displayName: 'Alice',
            createdAtExternal: null,
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
        return jsonResponse([
          { label: 'creator-fs', platform: 'fansly', username: 'creator' },
        ]);
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
});
