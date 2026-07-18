// Stage 32 Task 2 — one-time device-token issuance (kernel Stage 22
// adoption). The chatter signs in once with username+password in the options
// page; the extension trades the session for a device-bound bearer
// (`agency_hub_device_…`, sliding 90 d) stored in the settings record where
// the legacy chatter key lives (same storage.local custody class). The legacy
// key stays accepted as fallback (kernel dual-acceptance) — its retirement is
// a later, kernel-declared step.
//
// Browser flow, deliberately unlike the desktop's: Set-Cookie is a forbidden
// response header here, so the session cookie cannot be captured off the
// login response. Instead every call rides `credentials: 'include'` — the
// browser's own cookie jar carries the hub session between login, issue, and
// logout (the hub origin is covered by the granted optional host permission).

import { KernelApiError, createClient } from '@kernel/sdk';
import { ChatGooseError } from '../shared/errors.js';
import { clientVersionHeaders } from '../shared/client-version.js';

export interface IssueDeviceTokenInput {
  baseUrl: string;
  username: string;
  password: string;
  /** Shown in the owner's device-token admin list (browser/profile name). */
  label: string;
  fetchImpl?: typeof fetch;
}

export interface IssuedDeviceToken {
  token: string;
  keyPrefix: string;
  label: string;
  expiresAt: string;
}

export async function issueAgencyHubDeviceToken(
  input: IssueDeviceTokenInput,
): Promise<IssuedDeviceToken> {
  const baseFetch = input.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const credentialedFetch: typeof fetch = (request, init) =>
    baseFetch(request, { ...init, credentials: 'include' });

  const client = createClient({
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    auth: { mode: 'cookie' },
    headers: clientVersionHeaders(),
    fetch: credentialedFetch,
  });

  try {
    await client.login({
      body: { username: input.username.trim(), password: input.password },
    });
  } catch (error) {
    if (error instanceof KernelApiError && (error.status === 401 || error.status === 403)) {
      throw new ChatGooseError('hub_invalid_api_key', {
        details: { status: error.status, responseSnippet: 'Invalid username or password.' },
      });
    }
    throw new ChatGooseError('hub_request_failed', {
      details: {
        status: error instanceof KernelApiError ? error.status ?? 0 : 0,
        responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
      },
    });
  }

  try {
    const issued = await client.authIssueDeviceToken({ body: { label: input.label } });
    return {
      token: issued.token,
      keyPrefix: issued.keyPrefix,
      label: issued.label,
      expiresAt: issued.expiresAt,
    };
  } catch (error) {
    throw new ChatGooseError('hub_request_failed', {
      details: {
        status: error instanceof KernelApiError ? error.status ?? 0 : 0,
        responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
      },
    });
  } finally {
    // One-time session: best-effort hygiene, never fails the issuance.
    await client.logout().catch(() => undefined);
  }
}
