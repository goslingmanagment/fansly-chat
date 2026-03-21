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
    expect(result.reason).toContain('503');
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
});
