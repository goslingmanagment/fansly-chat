import { CLAUDE_API_BASE_URL } from './constants.js';

export function normalizeClaudeApiBaseUrl(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim().replace(/\/+$/, '');
  return normalized;
}

export function resolveClaudeApiBaseUrl(value: string | null | undefined): string {
  return normalizeClaudeApiBaseUrl(value) || CLAUDE_API_BASE_URL;
}

export function isDirectAnthropicApiBaseUrl(value: string | null | undefined): boolean {
  return resolveClaudeApiBaseUrl(value) === CLAUDE_API_BASE_URL;
}

export function buildClaudeApiMessagesUrl(value: string | null | undefined): string {
  return `${resolveClaudeApiBaseUrl(value)}/messages`;
}

export function getClaudeApiPermissionOrigin(value: string | null | undefined): string | null {
  const resolvedBaseUrl = resolveClaudeApiBaseUrl(value);
  if (resolvedBaseUrl === CLAUDE_API_BASE_URL) {
    return null;
  }

  try {
    return `${new URL(resolvedBaseUrl).origin}/*`;
  } catch {
    return null;
  }
}

export async function hasClaudeApiPermission(value: string | null | undefined): Promise<boolean> {
  const origin = getClaudeApiPermissionOrigin(value);
  if (!origin) {
    return true;
  }

  return browser.permissions.contains({ origins: [origin] });
}

export async function requestClaudeApiPermission(value: string | null | undefined): Promise<boolean> {
  const origin = getClaudeApiPermissionOrigin(value);
  if (!origin) {
    return false;
  }

  return browser.permissions.request({ origins: [origin] });
}
