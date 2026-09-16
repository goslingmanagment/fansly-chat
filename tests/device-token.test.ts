// E123 (PR-E1) — the single sign-in protocol: login + password → this device's
// own credential, in ONE public call, with no cookie and no logout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHubBearer } from '../src/background/agency-hub-client.js';
import { issueAgencyHubDeviceToken } from '../src/background/device-token.js';
import {
  buildDeviceLabel,
  healRevokedHubSession,
  resetHealedBearerMemo,
  selfHealingUnauthorizedReason,
  wipeHubCustody,
} from '../src/background/hub-custody.js';
import {
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY,
} from '../src/shared/constants.js';
import type { ChatGooseError } from '../src/shared/errors.js';

const PASSWORD_ROUTE = '/api/v1/auth/device-tokens/password';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function activeIssuance(): unknown {
  return {
    token: 'agency_hub_device_secret',
    id: 12,
    label: 'Firefox · Windows',
    keyPrefix: 'agency_hub_device_abc',
    expiresAt: '2026-12-14T00:00:00.000Z',
    mode: 'active',
  };
}

describe('resolveHubBearer', () => {
  it('is the device sign-in and nothing else (v17 retired the legacy key)', () => {
    expect(resolveHubBearer({ agencyHubDeviceToken: ' agency_hub_device_x ' }))
      .toBe('agency_hub_device_x');
    expect(resolveHubBearer({ agencyHubDeviceToken: '  ' })).toBe('');
    // A legacy runtime message may still omit the field entirely.
    expect(resolveHubBearer({} as unknown as Parameters<typeof resolveHubBearer>[0])).toBe('');
  });
});

describe('buildDeviceLabel', () => {
  it('names the device, never the build (Р7)', () => {
    expect(buildDeviceLabel('Mozilla/5.0 (Windows NT 10.0; rv:142.0) Gecko/20100101 Firefox/142.0'))
      .toBe('Firefox · Windows');
    expect(buildDeviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Firefox/142.0'))
      .toBe('Firefox · macOS');
    expect(buildDeviceLabel('Mozilla/5.0 (X11; Linux x86_64) Firefox/142.0'))
      .toBe('Firefox · Linux');
    expect(buildDeviceLabel('')).toBe('Firefox');
    // The kernel bounds the label at 120 chars; a long UA must not push past it.
    expect(buildDeviceLabel('Mozilla/5.0 (Windows NT 10.0)'.repeat(20)).length)
      .toBeLessThanOrEqual(120);
  });
});

describe('issueAgencyHubDeviceToken', () => {
  it('signs in with ONE public call: no cookie, no logout, no reservation', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href.endsWith(PASSWORD_ROUTE)) {
        return jsonResponse(activeIssuance());
      }
      throw new Error(`Unexpected URL: ${href}`);
    });

    const issued = await issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000/',
      username: ' dasha ',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(issued).toEqual({
      token: 'agency_hub_device_secret',
      keyPrefix: 'agency_hub_device_abc',
      label: 'Firefox · Windows',
      expiresAt: '2026-12-14T00:00:00.000Z',
    });
    // Exactly one request, and no `credentials: 'include'`: signing in from the
    // extension must not touch the profile's dashboard cookie (Р2).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://localhost:3000${PASSWORD_ROUTE}`);
    expect(calls[0]?.init?.credentials).not.toBe('include');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      mode: 'active',
    });
  });

  it('maps a rejected password to CG-HUB-17 and never retries', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'Unauthorized', message: 'invalid credentials', statusCode: 401 }, 401));

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'wrong',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_sign_in_rejected' } satisfies Partial<ChatGooseError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps password_change_required to CG-HUB-18, not to a wrong-password card', async () => {
    // The kernel's PRODUCTION shape: `PasswordChangeRequiredError` is a plain
    // AppError, so the machine code rides `error`, and there is no `reason` at
    // all (only UnauthorizedError declares one). Reading `reason` alone made
    // this a CG-HUB-17 «неверный логин или пароль» — a loop no password breaks.
    const fetchMock = vi.fn(async () => jsonResponse({
      error: 'password_change_required',
      message: "The owner must reset this account's password before it can sign in",
      statusCode: 403,
    }, 403));

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_password_change_required' });
  });

  it('a plain 403 without that code is still «неверный логин или пароль»', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: 'forbidden', message: 'Forbidden', statusCode: 403 },
      403,
    ));

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_sign_in_rejected' });
  });

  it('maps the per-IP rate limit to its own card, never «хаб недоступен»', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: 'Too Many Requests', message: 'Too many login attempts', statusCode: 429 },
      429,
    ));

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_sign_in_throttled' });
  });

  it('fails closed when the kernel answers with a reservation we never asked for', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      token: 'agency_hub_pending_device_secret',
      reservationId: 4,
      label: 'Firefox · Windows',
      keyPrefix: 'agency_hub_pending_device_abc',
      reservationExpiresAt: '2026-09-15T00:10:00.000Z',
      mode: 'pending',
    }));

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_request_failed' });
  });

  it('keeps a transport failure in the request-failed lane', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('NetworkError'); });

    await expect(issueAgencyHubDeviceToken({
      baseUrl: 'http://localhost:3000',
      username: 'dasha',
      password: 'pw',
      label: 'Firefox · Windows',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ key: 'hub_request_failed' });
  });
});

describe('§4.5 self-healing', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    resetHealedBearerMemo();
    store = {};
    (globalThis as Record<string, unknown>).browser = {
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            if (keys === null || keys === undefined) return { ...store };
            const list = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const key of list) {
              if (key in store) out[key] = store[key];
            }
            return out;
          },
          set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
          },
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('acts only on a reason the server named', () => {
    expect(selfHealingUnauthorizedReason({ status: 401, body: { reason: 'token_revoked' } }))
      .toBe('token_revoked');
    expect(selfHealingUnauthorizedReason({ status: 401, body: { reason: 'token_expired' } }))
      .toBe('token_expired');
    // A bare 401 is the fail-closed path: no reason, no wipe.
    expect(selfHealingUnauthorizedReason({ status: 401, body: {} })).toBeNull();
    expect(selfHealingUnauthorizedReason({ status: 401, body: null })).toBeNull();
    expect(selfHealingUnauthorizedReason({ status: 401, body: { reason: 'user_disabled' } }))
      .toBeNull();
    expect(selfHealingUnauthorizedReason({ status: 500, body: { reason: 'token_revoked' } }))
      .toBeNull();
  });

  it('wipes the sign-in and the retired slot when the rejected bearer is the stored one', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_live';
    store[LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY] = 'legacy-key';
    store[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY] = {
      version: 1, keyPrefix: 'p', issuedAt: 1, expiresAt: 'x',
    };

    await expect(healRevokedHubSession('agency_hub_device_live')).resolves.toBe(true);

    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
    expect(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY in store).toBe(false);
    expect(AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY in store).toBe(false);
  });

  it('leaves a NEWER sign-in alone when the 401 belonged to its predecessor', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_fresh';

    await expect(healRevokedHubSession('agency_hub_device_stale')).resolves.toBe(false);

    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('agency_hub_device_fresh');
  });

  it('reports the same completed wipe to both the SDK hook and its error mapper', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_old';
    const write = vi.spyOn(browser.storage.local, 'set');

    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(true);
    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
  });

  it('does not report a session ended after a newer sign-in replaces a healed one', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_old';
    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(true);
    const freshMeta = { version: 1, keyPrefix: 'fresh', issuedAt: 2, expiresAt: 'later' };
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_fresh';
    store[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY] = freshMeta;
    const write = vi.spyOn(browser.storage.local, 'set');
    const remove = vi.spyOn(browser.storage.local, 'remove');

    // A late mapper or second response can still refer to the already-healed
    // bearer. The memo must not describe the replacement as signed out.
    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(false);

    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('agency_hub_device_fresh');
    expect(store[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]).toEqual(freshMeta);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not use a previous wipe as proof when current custody cannot be read', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_old';
    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(true);
    vi.spyOn(browser.storage.local, 'get').mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(healRevokedHubSession('agency_hub_device_old')).resolves.toBe(false);
  });

  it('does nothing without a bearer to match', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_live';
    await expect(healRevokedHubSession('   ')).resolves.toBe(false);
    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('agency_hub_device_live');
  });

  it('empties the live slot but REMOVES the retired one', async () => {
    store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = 'agency_hub_device_live';
    store[LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY] = 'legacy-key';

    await wipeHubCustody();

    // The live slot keeps its key (the layout repair reads presence, E19);
    // the retired slot is gone for good (E123).
    expect(AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY in store).toBe(true);
    expect(store[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
    expect(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY in store).toBe(false);
  });
});
