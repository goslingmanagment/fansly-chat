// Stage 32 Task 2 — device-token issuance (browser flow) + bearer fallback.

import { describe, expect, it, vi } from 'vitest';
import { resolveHubBearer } from '../src/background/agency-hub-client.js';
import { issueAgencyHubDeviceToken } from '../src/background/device-token.js';
import type { ChatGooseError } from '../src/shared/errors.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveHubBearer (kernel dual-acceptance)', () => {
  it('prefers the device token and falls back to the legacy key', () => {
    expect(resolveHubBearer({ agencyHubApiKey: 'legacy', agencyHubDeviceToken: 'agency_hub_device_x' }))
      .toBe('agency_hub_device_x');
    expect(resolveHubBearer({ agencyHubApiKey: 'legacy', agencyHubDeviceToken: '  ' }))
      .toBe('legacy');
    expect(resolveHubBearer({ agencyHubApiKey: '', agencyHubDeviceToken: '' })).toBe('');
  });
});

describe('issueAgencyHubDeviceToken', () => {
  it('logs in with browser credentials, issues the token, and logs out', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          authMethod: 'session',
          user: {
            id: 7,
            username: 'dasha',
            role: 'chatter',
            mustChangePassword: false,
            assignedPages: [],
          },
        });
      }
      if (href.endsWith('/api/v1/auth/device-tokens')) {
        return jsonResponse({
          token: 'agency_hub_device_secret',
          id: 12,
          label: 'chatgoose-extension firefox',
          keyPrefix: 'agency_hub_device_abc',
          expiresAt: '2026-10-04T00:00:00.000Z',
        });
      }
      if (href.endsWith('/api/v1/auth/logout')) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });

    const issued = await issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000/',
      username: ' dasha ',
      password: 'pw',
      label: 'chatgoose-extension firefox',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(issued).toEqual({
      token: 'agency_hub_device_secret',
      keyPrefix: 'agency_hub_device_abc',
      label: 'chatgoose-extension firefox',
      expiresAt: '2026-10-04T00:00:00.000Z',
    });
    // Browser cookie jar carries the session: every call rides credentials
    // 'include' (Set-Cookie is unreadable to extension JS — no header capture).
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.credentials).toBe('include');
    }
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/auth/login');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ username: 'dasha', password: 'pw' });
    expect(calls[2]?.url).toBe('http://localhost:3000/api/v1/auth/logout');
  });

  it('maps a rejected login to the invalid-credential error and never issues', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).endsWith('/api/v1/auth/login')) {
        return jsonResponse({ error: 'Unauthorized', message: 'bad credentials', statusCode: 401 }, 401);
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'wrong',
      label: 'label',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_invalid_api_key' } satisfies Partial<ChatGooseError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still logs out when issuance fails, and surfaces the failure', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          authMethod: 'session',
          user: {
            id: 7,
            username: 'dasha',
            role: 'chatter',
            mustChangePassword: false,
            assignedPages: [],
          },
        });
      }
      if (href.endsWith('/api/v1/auth/device-tokens')) {
        return jsonResponse({ error: 'Bad Request', message: 'label too long', statusCode: 400 }, 400);
      }
      if (href.endsWith('/api/v1/auth/logout')) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'x'.repeat(500),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_request_failed' });
    expect(calls.some((href) => href.endsWith('/api/v1/auth/logout'))).toBe(true);
  });
});
