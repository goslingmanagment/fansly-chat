import type {
  AgencyHubSummarySyncMetadata,
  FanSummarySyncStatus,
  FanSummarySyncState,
} from './types.js';
import { canonicalizePersistedUserError } from './errors.js';

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

export function normalizeAgencyHubSummarySyncMetadata(
  metadata: AgencyHubSummarySyncMetadata | undefined,
): FanSummarySyncStatus | undefined {
  if (!metadata) {
    return undefined;
  }

  const state: FanSummarySyncState = metadata.state ?? 'saved';
  return {
    state,
    generatedAt: metadata.generatedAt,
    ...(metadata.baseUrl ? { baseUrl: normalizeAgencyHubBaseUrl(metadata.baseUrl) } : {}),
    ...(metadata.pageLabel ? { pageLabel: metadata.pageLabel } : {}),
    ...(typeof metadata.syncedAt === 'number' ? { syncedAt: metadata.syncedAt } : {}),
    ...(typeof metadata.updatedAt === 'number' ? { updatedAt: metadata.updatedAt } : {}),
    ...('error' in metadata && metadata.error
      ? { error: canonicalizePersistedUserError(metadata.error) }
      : {}),
  };
}

export function isAgencyHubSummarySavedForBaseUrl(
  metadata: AgencyHubSummarySyncMetadata | undefined,
  baseUrl: string | null | undefined,
  generatedAt: number,
): boolean {
  const normalizedMetadata = normalizeAgencyHubSummarySyncMetadata(metadata);
  const normalizedBaseUrl = normalizeAgencyHubBaseUrl(baseUrl);
  return Boolean(
    normalizedMetadata &&
    normalizedMetadata.state === 'saved' &&
    normalizedMetadata.generatedAt === generatedAt &&
    normalizedMetadata.baseUrl === normalizedBaseUrl &&
    normalizedMetadata.pageLabel,
  );
}

export function hasAgencyHubSyncMetadata(
  metadata: AgencyHubSummarySyncMetadata | undefined,
  baseUrl: string,
  pageLabel: string,
  generatedAt: number,
): boolean {
  const normalizedMetadata = normalizeAgencyHubSummarySyncMetadata(metadata);
  return Boolean(
    normalizedMetadata &&
    normalizedMetadata.state === 'saved' &&
    normalizedMetadata.baseUrl === baseUrl &&
    normalizedMetadata.pageLabel === pageLabel &&
    normalizedMetadata.generatedAt === generatedAt,
  );
}
