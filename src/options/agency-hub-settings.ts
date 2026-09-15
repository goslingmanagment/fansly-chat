import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import type { UserFacingError } from '../shared/types.js';
import { COPY } from './copy.js';

export interface AgencyHubPermissionCheckResult {
  granted: boolean;
  errorMessage: string | null;
}

export type AgencyHubPermissionFeedback =
  | { kind: 'denied'; originPattern: string }
  | { kind: 'request_error'; originPattern: string; errorMessage: string }
  | { kind: 'unsupported'; originPattern: string };

export type AgencyHubConnectionFeedback =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'testing' }
  | { kind: 'connected'; baseUrl: string }
  | { kind: 'failed'; error: UserFacingError };

export function formatAgencyHubError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message ? `${error.name}: ${message}` : error.name;
  }

  return String(error);
}

export function appendAgencyHubMeta(baseText: string, note: string | null): string {
  return note ? `${baseText} ${note}` : baseText;
}

export function buildAgencyHubPermissionScopeNote(
  baseUrl: string | null | undefined,
): string | null {
  const normalized = normalizeAgencyHubBaseUrl(baseUrl);
  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);
  if (!parsed.port) {
    return null;
  }

  const originPattern = buildAgencyHubOriginPattern(normalized);
  if (!originPattern) {
    return null;
  }

  return COPY.hubSettings.portScopeNote
    .replace('{origin}', originPattern)
    .replace('{url}', normalized);
}

export function buildAgencyHubConnectionSignature(
  baseUrl: string,
  deviceToken: string,
): string {
  return `${normalizeAgencyHubBaseUrl(baseUrl)}|${deviceToken.trim()}`;
}

/** v17 (E123): one credential class. A connection is testable once the chatter
 * has signed in and an address is known. */
export function hasAgencyHubConnectionInputs(
  baseUrl: string,
  deviceToken: string,
): boolean {
  return Boolean(baseUrl.trim() && deviceToken.trim());
}

export async function getAgencyHubPermissionCheck(
  originPattern: string | null,
): Promise<AgencyHubPermissionCheckResult> {
  if (!originPattern) {
    return { granted: false, errorMessage: null };
  }

  if (typeof browser.permissions?.contains !== 'function') {
    return { granted: true, errorMessage: null };
  }

  try {
    return {
      granted: await browser.permissions.contains({ origins: [originPattern] }),
      errorMessage: null,
    };
  } catch (error) {
    return {
      granted: false,
      errorMessage: formatAgencyHubError(error),
    };
  }
}
