import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import type { UserFacingError } from '../shared/types.js';

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

  return `Firefox выдаёт доступ к хосту целиком, а не по портам, поэтому ${originPattern} покрывает указанный URL ${normalized}.`;
}

export function buildAgencyHubConnectionSignature(
  baseUrl: string,
  apiKey: string,
  deviceToken = '',
): string {
  return `${normalizeAgencyHubBaseUrl(baseUrl)}|${apiKey.trim()}|${deviceToken.trim()}`;
}

/** A hub connection is testable with EITHER credential: the device token
 * (preferred since 1.7.0) or the legacy chatter key. */
export function hasAgencyHubConnectionInputs(
  baseUrl: string,
  apiKey: string,
  deviceToken = '',
): boolean {
  return Boolean(baseUrl.trim() && (apiKey.trim() || deviceToken.trim()));
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
