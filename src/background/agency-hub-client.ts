import {
  AGENCY_HUB_PROFILE_MAX_BYTES,
  buildAgencyHubOriginPattern,
  buildAgencyHubUrl,
  hasAgencyHubSyncMetadata,
  measureUtf8Bytes,
  normalizeAgencyHubBaseUrl,
  normalizeAgencyHubUsername,
} from '../shared/agency-hub.js';
import type { AgencyHubSummarySyncMetadata, Settings } from '../shared/types.js';

interface AgencyHubPageSummary {
  label: string;
  platform: 'fansly' | 'onlyfans';
  username: string | null;
}

interface AgencyHubProfileRecord {
  version: number;
  body: string;
  source: 'chatmuse';
  createdAt: string;
  createdByUserId: number | null;
}

interface AgencyHubConversationProfileResponse {
  fan: {
    platform: 'fansly' | 'onlyfans';
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    createdAtExternal: string | null;
  };
  profile: AgencyHubProfileRecord | null;
}

type FetchLike = typeof fetch;

export interface AgencyHubPushFanProfileInput {
  settings: Settings;
  pageUsername: string | null;
  platformUserId: string | null;
  body: string;
  signal: AbortSignal;
  existingSync?: AgencyHubSummarySyncMetadata;
  generatedAt?: number;
}

export interface AgencyHubPushFanProfileResult {
  status: 'pushed' | 'already-synced' | 'skipped' | 'failed';
  reason: string;
  baseUrl: string | null;
  pageLabel?: string;
}

export interface AgencyHubFetchFanProfileInput {
  settings: Settings;
  pageUsername: string | null;
  conversationId: string | null;
  signal: AbortSignal;
}

export interface AgencyHubFetchFanProfileResult {
  status: 'fetched' | 'not-found' | 'skipped' | 'failed';
  reason: string;
  baseUrl: string | null;
  pageLabel?: string;
  body?: string;
  createdAtMs?: number;
  fanAccountId?: string;
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}

export class AgencyHubClient {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) {
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
  }

  isConfigured(settings: Settings): boolean {
    return Boolean(
      normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl) &&
      settings.agencyHubApiKey.trim(),
    );
  }

  private async hasHostPermission(baseUrl: string): Promise<boolean> {
    const originPattern = buildAgencyHubOriginPattern(baseUrl);
    if (!originPattern) {
      return false;
    }

    if (typeof browser.permissions?.contains !== 'function') {
      return true;
    }

    try {
      return await browser.permissions.contains({ origins: [originPattern] });
    } catch {
      return false;
    }
  }

  private async listVisiblePages(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<AgencyHubPageSummary[]> {
    const response = await this.fetchImpl(buildAgencyHubUrl(baseUrl, 'api/v1/pages'), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      signal,
    });

    if (!response.ok) {
      const snippet = await readResponseSnippet(response);
      throw new Error(`GET /api/v1/pages failed (${response.status}) ${snippet}`.trim());
    }

    return await response.json() as AgencyHubPageSummary[];
  }

  private resolvePageLabel(
    pages: AgencyHubPageSummary[],
    pageUsername: string | null,
  ): string | null {
    const normalizedPageUsername = normalizeAgencyHubUsername(pageUsername);
    if (!normalizedPageUsername) {
      return null;
    }

    const matches = pages.filter((page) =>
      page.platform === 'fansly' &&
      normalizeAgencyHubUsername(page.username) === normalizedPageUsername
    );

    if (matches.length !== 1) {
      return null;
    }

    const pageLabel = matches[0]?.label?.trim() ?? '';
    return pageLabel || null;
  }

  private async getConversationProfile(
    baseUrl: string,
    apiKey: string,
    pageLabel: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<AgencyHubConversationProfileResponse | null> {
    const response = await this.fetchImpl(
      buildAgencyHubUrl(
        baseUrl,
        `api/v1/pages/${encodeURIComponent(pageLabel)}/conversations/${encodeURIComponent(conversationId)}/profile`,
      ),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        signal,
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const snippet = await readResponseSnippet(response);
      throw new Error(`GET /conversations/profile failed (${response.status}) ${snippet}`.trim());
    }

    return await response.json() as AgencyHubConversationProfileResponse;
  }

  private async putFanProfile(
    baseUrl: string,
    apiKey: string,
    pageLabel: string,
    platformUserId: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(
      buildAgencyHubUrl(
        baseUrl,
        `api/v1/pages/${encodeURIComponent(pageLabel)}/fans/${encodeURIComponent(platformUserId)}/profile`,
      ),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body }),
        signal,
      },
    );

    if (!response.ok) {
      const snippet = await readResponseSnippet(response);
      throw new Error(`PUT /profile failed (${response.status}) ${snippet}`.trim());
    }
  }

  async pushFanProfile({
    settings,
    pageUsername,
    platformUserId,
    body,
    signal,
    existingSync,
    generatedAt,
  }: AgencyHubPushFanProfileInput): Promise<AgencyHubPushFanProfileResult> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = settings.agencyHubApiKey.trim();

    if (!baseUrl) {
      return { status: 'skipped', reason: 'missing_base_url', baseUrl: null };
    }
    if (!apiKey) {
      return { status: 'skipped', reason: 'missing_api_key', baseUrl };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return { status: 'skipped', reason: 'missing_host_permission', baseUrl };
    }
    if (!body.length) {
      return { status: 'skipped', reason: 'empty_body', baseUrl };
    }
    if (measureUtf8Bytes(body) > AGENCY_HUB_PROFILE_MAX_BYTES) {
      return { status: 'skipped', reason: 'body_too_large', baseUrl };
    }

    const normalizedPageUsername = normalizeAgencyHubUsername(pageUsername);
    if (!normalizedPageUsername) {
      return { status: 'skipped', reason: 'missing_page_username', baseUrl };
    }

    const trimmedPlatformUserId = platformUserId?.trim() ?? '';
    if (!trimmedPlatformUserId) {
      return { status: 'skipped', reason: 'missing_platform_user_id', baseUrl };
    }

    try {
      const pages = await this.listVisiblePages(baseUrl, apiKey, signal);
      const pageLabel = this.resolvePageLabel(pages, normalizedPageUsername);
      if (!pageLabel) {
        return { status: 'skipped', reason: 'page_match_failed', baseUrl };
      }

      if (
        generatedAt !== undefined &&
        hasAgencyHubSyncMetadata(existingSync, baseUrl, pageLabel, generatedAt)
      ) {
        return {
          status: 'already-synced',
          reason: 'already_synced',
          baseUrl,
          pageLabel,
        };
      }

      await this.putFanProfile(
        baseUrl,
        apiKey,
        pageLabel,
        trimmedPlatformUserId,
        body,
        signal,
      );
      return {
        status: 'pushed',
        reason: 'pushed',
        baseUrl,
        pageLabel,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { status: 'failed', reason: 'aborted', baseUrl };
      }

      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown_error',
        baseUrl,
      };
    }
  }

  async fetchFanProfileByConversation({
    settings,
    pageUsername,
    conversationId,
    signal,
  }: AgencyHubFetchFanProfileInput): Promise<AgencyHubFetchFanProfileResult> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = settings.agencyHubApiKey.trim();

    if (!baseUrl) {
      return { status: 'skipped', reason: 'missing_base_url', baseUrl: null };
    }
    if (!apiKey) {
      return { status: 'skipped', reason: 'missing_api_key', baseUrl };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return { status: 'skipped', reason: 'missing_host_permission', baseUrl };
    }

    const normalizedPageUsername = normalizeAgencyHubUsername(pageUsername);
    if (!normalizedPageUsername) {
      return { status: 'skipped', reason: 'missing_page_username', baseUrl };
    }

    const trimmedConversationId = conversationId?.trim() ?? '';
    if (!trimmedConversationId) {
      return { status: 'skipped', reason: 'missing_conversation_id', baseUrl };
    }

    try {
      const pages = await this.listVisiblePages(baseUrl, apiKey, signal);
      const pageLabel = this.resolvePageLabel(pages, normalizedPageUsername);
      if (!pageLabel) {
        return { status: 'skipped', reason: 'page_match_failed', baseUrl };
      }

      const profileResponse = await this.getConversationProfile(
        baseUrl,
        apiKey,
        pageLabel,
        trimmedConversationId,
        signal,
      );
      if (!profileResponse?.profile) {
        return {
          status: 'not-found',
          reason: 'profile_missing',
          baseUrl,
          pageLabel,
        };
      }

      const body = profileResponse.profile.body.trim();
      if (!body) {
        return {
          status: 'not-found',
          reason: 'empty_body',
          baseUrl,
          pageLabel,
        };
      }

      if (measureUtf8Bytes(body) > AGENCY_HUB_PROFILE_MAX_BYTES) {
        return {
          status: 'skipped',
          reason: 'body_too_large',
          baseUrl,
          pageLabel,
        };
      }

      const createdAtMs = Date.parse(profileResponse.profile.createdAt);
      const fanAccountId = profileResponse.fan.platformUserId.trim();

      return {
        status: 'fetched',
        reason: 'fetched',
        baseUrl,
        pageLabel,
        body,
        ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
        ...(fanAccountId ? { fanAccountId } : {}),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { status: 'failed', reason: 'aborted', baseUrl };
      }

      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown_error',
        baseUrl,
      };
    }
  }
}
