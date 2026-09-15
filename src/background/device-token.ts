// E79 (PR-E1) — one sign-in protocol for every ChatGoose client, and no cookie.
//
// The chatter types a login and a password once in «Аккаунт ChatGoose»; the
// extension trades them for a device-bound bearer through the kernel's public
// `POST /auth/device-tokens/password` route in `active` mode, and the caller
// commits that bearer in ONE atomic `storage.local.set` inside the custody
// FIFO.
//
// What this replaces (Stage 32): a cookie login → issue → logout dance. Two
// things made it wrong here. Firefox carries the hub session in the profile's
// own cookie jar, so signing in from the extension logged the dashboard out in
// the same browser; and the logout at the end was a best-effort call that could
// leave a stray session behind. There is also no reserve→activate here on
// purpose (Р2): the extension's custody is a single key, so a pending token in
// the live slot would answer 401 for the whole reservation window.
//
// Nothing about the credential reaches the user's vocabulary: the options page
// speaks of «вход» and «устройство» only.

import { KernelApiError, createClient } from '@kernel/sdk';
import { ChatGooseError } from '../shared/errors.js';
import { clientVersionHeaders } from '../shared/client-version.js';

export interface IssueDeviceTokenInput {
  baseUrl: string;
  username: string;
  password: string;
  /** The device's name in the owner's console and in «Ваши устройства». */
  label: string;
  fetchImpl?: typeof fetch;
}

export interface IssuedDeviceToken {
  token: string;
  keyPrefix: string;
  label: string;
  expiresAt: string;
}

/** The kernel names WHY it refused, in the `reason` field every error response
 * carries (`errorResponseSchema`). Absent on older cores — the caller then
 * falls back to the generic «неверный логин или пароль» card, which is the
 * honest reading of a 401 on this route. */
export function readErrorReason(error: KernelApiError): string | null {
  if (!error.body || typeof error.body !== 'object') {
    return null;
  }
  const reason = (error.body as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason ? reason : null;
}

function responseSnippet(error: KernelApiError): string {
  if (typeof error.body === 'string' && error.body.trim()) {
    return error.body.slice(0, 400);
  }
  if (error.body && typeof error.body === 'object') {
    try {
      return JSON.stringify(error.body).slice(0, 400);
    } catch {
      // fall through
    }
  }
  return error.message.slice(0, 400);
}

export async function issueAgencyHubDeviceToken(
  input: IssueDeviceTokenInput,
): Promise<IssuedDeviceToken> {
  const baseFetch = input.fetchImpl
    ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  // Bearer-less on purpose: the route is public, and this device has nothing to
  // present yet. No `credentials: 'include'`, so the profile's hub cookie is
  // neither read nor written by the sign-in.
  const client = createClient({
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    headers: clientVersionHeaders(),
    fetch: baseFetch,
  });

  try {
    const issued = await client.authIssueDeviceTokenWithPassword({
      body: {
        username: input.username.trim(),
        password: input.password,
        label: input.label,
        mode: 'active',
      },
    });
    if (issued.mode !== 'active') {
      // The kernel answered with a reservation although we asked for a live
      // sign-in. Fail closed: storing a pending bearer in the live slot would
      // 401 every request until it was activated, and this client never
      // activates.
      throw new ChatGooseError('hub_request_failed', {
        details: { status: 200, responseSnippet: 'Unexpected pending sign-in response.' },
      });
    }
    return {
      token: issued.token,
      keyPrefix: issued.keyPrefix,
      label: issued.label,
      expiresAt: issued.expiresAt,
    };
  } catch (error) {
    if (error instanceof ChatGooseError) {
      throw error;
    }
    if (error instanceof KernelApiError) {
      const reason = readErrorReason(error);
      if (reason === 'password_change_required') {
        throw new ChatGooseError('hub_password_change_required', {
          details: { status: error.status ?? 0, responseSnippet: responseSnippet(error) },
        });
      }
      if (error.status === 401 || error.status === 403) {
        throw new ChatGooseError('hub_sign_in_rejected', {
          details: { status: error.status, responseSnippet: responseSnippet(error) },
        });
      }
      throw new ChatGooseError('hub_request_failed', {
        details: { status: error.status ?? 0, responseSnippet: responseSnippet(error) },
      });
    }
    throw new ChatGooseError('hub_request_failed', {
      details: {
        status: 0,
        responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
      },
    });
  }
}
