import {
  AGENCY_HUB_PROFILE_MAX_BYTES,
  buildAgencyHubOriginPattern,
  buildAgencyHubUrl,
  hasAgencyHubSyncMetadata,
  measureUtf8Bytes,
  normalizeAgencyHubBaseUrl,
  normalizeAgencyHubUsername,
} from '../shared/agency-hub.js';
import {
  ChatGooseError,
  createUserError,
  toUserError,
} from '../shared/errors.js';
import type {
  AgencyHubConnectionTestResponse,
  AgencyHubSummarySyncMetadata,
  Settings,
  UserFacingError,
} from '../shared/types.js';

interface AgencyHubPageSummary {
  label: string;
  platform: 'fansly' | 'onlyfans';
  username: string | null;
}

interface AgencyHubProfileRecord {
  version: number;
  body: string;
  source: 'chatgoose';
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

interface AgencyHubResultBase {
  reason: string;
  baseUrl: string | null;
  pageLabel?: string;
  error?: UserFacingError;
}

export interface AgencyHubPushFanProfileInput {
  settings: Settings;
  pageUsername: string | null;
  platformUserId: string | null;
  body: string;
  signal: AbortSignal;
  existingSync?: AgencyHubSummarySyncMetadata;
  generatedAt?: number;
}

export interface AgencyHubPushFanProfileResult extends AgencyHubResultBase {
  status: 'pushed' | 'already-synced' | 'skipped' | 'failed';
}

export interface AgencyHubFetchFanProfileInput {
  settings: Settings;
  pageUsername: string | null;
  conversationId: string | null;
  signal: AbortSignal;
}

export interface AgencyHubFetchFanProfileResult extends AgencyHubResultBase {
  status: 'fetched' | 'not-found' | 'skipped' | 'failed';
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

function hubError(
  key: Parameters<typeof createUserError>[0],
  overrides?: Partial<Pick<UserFacingError, 'description'>>,
): UserFacingError {
  return createUserError(key, overrides);
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

  private async createHubResponseError(
    response: Response,
    fallbackKey: 'hub_request_failed' | 'hub_invalid_api_key' = 'hub_request_failed',
  ): Promise<ChatGooseError> {
    const snippet = await readResponseSnippet(response);
    const key = response.status === 401 || response.status === 403
      ? 'hub_invalid_api_key'
      : fallbackKey;
    return new ChatGooseError(key, {
      details: {
        status: response.status,
        responseSnippet: snippet,
      },
    });
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
      throw await this.createHubResponseError(response);
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
      throw await this.createHubResponseError(response);
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
      throw await this.createHubResponseError(response);
    }
  }

  async testConnection(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey'>,
    signal: AbortSignal,
  ): Promise<AgencyHubConnectionTestResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = settings.agencyHubApiKey.trim();

    if (!settings.agencyHubBaseUrl.trim() || !baseUrl) {
      return { ok: false, error: hubError('hub_invalid_url') };
    }
    if (!apiKey) {
      return { ok: false, error: hubError('hub_missing_api_key') };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return { ok: false, error: hubError('hub_missing_permission') };
    }

    try {
      await this.listVisiblePages(baseUrl, apiKey, signal);
      return { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: hubError('hub_timeout') };
      }

      return {
        ok: false,
        error: error instanceof ChatGooseError
          ? toUserError(error)
          : hubError('hub_request_failed'),
      };
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
      return {
        status: 'skipped',
        reason: 'missing_base_url',
        baseUrl: null,
        error: hubError('hub_invalid_url'),
      };
    }
    if (!apiKey) {
      return {
        status: 'skipped',
        reason: 'missing_api_key',
        baseUrl,
        error: hubError('hub_missing_api_key'),
      };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return {
        status: 'skipped',
        reason: 'missing_host_permission',
        baseUrl,
        error: hubError('hub_missing_permission'),
      };
    }
    if (!body.length) {
      return { status: 'skipped', reason: 'empty_body', baseUrl };
    }
    if (measureUtf8Bytes(body) > AGENCY_HUB_PROFILE_MAX_BYTES) {
      return {
        status: 'skipped',
        reason: 'body_too_large',
        baseUrl,
        error: hubError('hub_request_failed', {
          description: 'The generated summary is too large to store in Agency Hub.',
        }),
      };
    }

    const normalizedPageUsername = normalizeAgencyHubUsername(pageUsername);
    if (!normalizedPageUsername) {
      return {
        status: 'failed',
        reason: 'missing_page_username',
        baseUrl,
        error: hubError('hub_page_match_failed'),
      };
    }

    const trimmedPlatformUserId = platformUserId?.trim() ?? '';
    if (!trimmedPlatformUserId) {
      return {
        status: 'failed',
        reason: 'missing_platform_user_id',
        baseUrl,
        error: hubError('hub_request_failed', {
          description: 'ChatGoose could not resolve the fan account id for Agency Hub sync.',
        }),
      };
    }

    try {
      const pages = await this.listVisiblePages(baseUrl, apiKey, signal);
      const pageLabel = this.resolvePageLabel(pages, normalizedPageUsername);
      if (!pageLabel) {
        return {
          status: 'failed',
          reason: 'page_match_failed',
          baseUrl,
          error: hubError('hub_page_match_failed'),
        };
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
        return {
          status: 'failed',
          reason: 'aborted',
          baseUrl,
          error: hubError('hub_timeout'),
        };
      }

      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown_error',
        baseUrl,
        error: error instanceof ChatGooseError
          ? toUserError(error)
          : hubError('hub_request_failed'),
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
      return {
        status: 'skipped',
        reason: 'missing_base_url',
        baseUrl: null,
        error: hubError('hub_invalid_url'),
      };
    }
    if (!apiKey) {
      return {
        status: 'skipped',
        reason: 'missing_api_key',
        baseUrl,
        error: hubError('hub_missing_api_key'),
      };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return {
        status: 'skipped',
        reason: 'missing_host_permission',
        baseUrl,
        error: hubError('hub_missing_permission'),
      };
    }

    const normalizedPageUsername = normalizeAgencyHubUsername(pageUsername);
    if (!normalizedPageUsername) {
      return {
        status: 'failed',
        reason: 'missing_page_username',
        baseUrl,
        error: hubError('hub_page_match_failed'),
      };
    }

    const trimmedConversationId = conversationId?.trim() ?? '';
    if (!trimmedConversationId) {
      return {
        status: 'failed',
        reason: 'missing_conversation_id',
        baseUrl,
        error: hubError('hub_request_failed', {
          description: 'ChatGoose could not resolve the current conversation id for Agency Hub lookup.',
        }),
      };
    }

    try {
      const pages = await this.listVisiblePages(baseUrl, apiKey, signal);
      const pageLabel = this.resolvePageLabel(pages, normalizedPageUsername);
      if (!pageLabel) {
        return {
          status: 'failed',
          reason: 'page_match_failed',
          baseUrl,
          error: hubError('hub_page_match_failed'),
        };
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
          status: 'failed',
          reason: 'body_too_large',
          baseUrl,
          pageLabel,
          error: hubError('hub_request_failed', {
            description: 'The stored Agency Hub profile is too large for ChatGoose to use.',
          }),
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
        return {
          status: 'failed',
          reason: 'aborted',
          baseUrl,
          error: hubError('hub_timeout'),
        };
      }

      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown_error',
        baseUrl,
        error: error instanceof ChatGooseError
          ? toUserError(error)
          : hubError('hub_request_failed'),
      };
    }
  }
}
