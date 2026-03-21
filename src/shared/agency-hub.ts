import type { AgencyHubSummarySyncMetadata } from './types.js';

export const AGENCY_HUB_PROFILE_MAX_BYTES = 50_000;

export function normalizeAgencyHubBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname === '/' ? '' : pathname}`;
  } catch {
    return '';
  }
}

export function buildAgencyHubOriginPattern(baseUrl: string | null | undefined): string | null {
  const normalized = normalizeAgencyHubBaseUrl(baseUrl);
  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function buildAgencyHubUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = normalizeAgencyHubBaseUrl(baseUrl);
  const normalizedPath = path.replace(/^\/+/, '');
  return new URL(normalizedPath, `${normalizedBaseUrl}/`);
}

export function normalizeAgencyHubUsername(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^@+/, '').toLowerCase() ?? '';
  return normalized || null;
}

export function measureUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function hasAgencyHubSyncMetadata(
  metadata: AgencyHubSummarySyncMetadata | undefined,
  baseUrl: string,
  pageLabel: string,
  generatedAt: number,
): boolean {
  return Boolean(
    metadata &&
    metadata.baseUrl === baseUrl &&
    metadata.pageLabel === pageLabel &&
    metadata.generatedAt === generatedAt,
  );
}
