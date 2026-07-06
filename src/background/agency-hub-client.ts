import { KernelApiError, createClient } from '@kernel/sdk';
import { clientVersionHeaders } from '../shared/client-version.js';
import {
  AGENCY_HUB_PROFILE_MAX_BYTES,
  buildAgencyHubOriginPattern,
  hasAgencyHubSyncMetadata,
  measureUtf8Bytes,
  normalizeAgencyHubBaseUrl,
  normalizeAgencyHubUsername,
} from '../shared/agency-hub.js';
import { AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS } from '../shared/constants.js';
import {
  ChatGooseError,
  createUserError,
  toUserError,
} from '../shared/errors.js';
import type {
  AgencyHubAiUsageBatchResponse,
  AgencyHubAiUsageEvent,
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
    pageAlias: string | null;
  };
  profile: AgencyHubProfileRecord | null;
}

type FetchLike = typeof fetch;

/** Hub bearer: device token preferred, legacy chatter key fallback
 * (kernel dual-acceptance holds through the Stage 32 rollout window). */
export function resolveHubBearer(
  settings: Pick<Settings, 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
): string {
  const deviceToken = settings.agencyHubDeviceToken.trim();
  return deviceToken || settings.agencyHubApiKey.trim();
}

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

export interface AgencyHubSubmitAiUsageBatchInput {
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>;
  events: AgencyHubAiUsageEvent[];
  signal: AbortSignal;
}

export interface AgencyHubSubmitAiUsageBatchResult extends AgencyHubResultBase {
  status: 'submitted' | 'skipped' | 'failed';
  response?: AgencyHubAiUsageBatchResponse;
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
      resolveHubBearer(settings),
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

  /** SDK client bound to one call: bearer + abort signal ride the fetch seam
   * (the vendored SDK has no per-operation signal parameter). Responses are
   * contract-validated by the SDK — the old `as` casts are gone. */
  private sdkFor(baseUrl: string, bearer: string, signal: AbortSignal) {
    return createClient({
      baseUrl: baseUrl.replace(/\/+$/, ''),
      auth: { mode: 'bearer', token: () => bearer },
      headers: clientVersionHeaders(),
      fetch: (input, init) => this.fetchImpl(input, { ...init, signal }),
    });
  }

  /** Map SDK failures back onto the public contract the callers already
   * handle: HTTP errors become ChatGooseError keys, aborts resurface as
   * AbortError DOMExceptions, and plain network failures rethrow as bare
   * Errors so their message survives into the result's `reason`. */
  private toHubError(error: unknown): ChatGooseError {
    if (error instanceof KernelApiError) {
      if (error.category === 'network') {
        if (error.code === 'aborted') {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw new Error(error.message);
      }
      const key = error.status === 401 || error.status === 403
        ? 'hub_invalid_api_key'
        : 'hub_request_failed';
      return new ChatGooseError(key, {
        details: {
          status: error.status ?? 0,
          responseSnippet: error.message.slice(0, 400),
        },
      });
    }
    if (error instanceof ChatGooseError || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    return new ChatGooseError('hub_request_failed', {
      details: {
        status: 0,
        responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
      },
    });
  }

  private async listVisiblePages(
    baseUrl: string,
    bearer: string,
    signal: AbortSignal,
  ): Promise<AgencyHubPageSummary[]> {
    try {
      return await this.sdkFor(baseUrl, bearer, signal).pages();
    } catch (error) {
      throw this.toHubError(error);
    }
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
    try {
      return await this.sdkFor(baseUrl, apiKey, signal).pageConversationProfile({
        params: { pageLabel, conversationId },
      });
    } catch (error) {
      // 404 is a domain result (fan/profile unknown to the hub), not an error.
      if (error instanceof KernelApiError && error.status === 404) {
        return null;
      }
      throw this.toHubError(error);
    }
  }

  private async putFanProfile(
    baseUrl: string,
    apiKey: string,
    pageLabel: string,
    platformUserId: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.sdkFor(baseUrl, apiKey, signal).upsertFanProfile({
        params: { pageLabel, platformUserId },
        body: { body },
      });
    } catch (error) {
      throw this.toHubError(error);
    }
  }

  private async postAiUsageBatch(
    baseUrl: string,
    apiKey: string,
    events: AgencyHubAiUsageEvent[],
    signal: AbortSignal,
  ): Promise<AgencyHubAiUsageBatchResponse> {
    try {
      return await this.sdkFor(baseUrl, apiKey, signal).aiUsageBatch({
        body: { events },
      });
    } catch (error) {
      throw this.toHubError(error);
    }
  }

  /** Stage 32: the feature lane needs the kernel page label for the signed-in
   * Fansly creator. Exact-match rule over the SDK pages list (the profile
   * push's resolvePageLabel, exposed). Null = unmapped (caller surfaces it). */
  async resolvePageLabelForUsername(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
    pageUsername: string | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer || !await this.hasHostPermission(baseUrl)) {
      return null;
    }
    const pages = await this.listVisiblePages(baseUrl, bearer, signal);
    return this.resolvePageLabel(pages, pageUsername);
  }

  /** Stage 32 Task 4: one kernel query replaces the board's Fansly earnings
   * sweep. Snapshot-honest: builtAt = the projection's freshest observation. */
  async fetchTopSpenders(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
    pageLabel: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    builtAt: string | null;
    fanCount: number;
    entries: Array<{
      platformUserId: string;
      username: string | null;
      displayName: string | null;
      grossMills: number;
    }>;
  }> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) {
      throw new ChatGooseError('hub_missing_api_key');
    }
    try {
      const snapshot = await this.sdkFor(baseUrl, bearer, signal).pageTopSpenders({
        params: { pageLabel },
        query: { window: 'lifetime', limit },
      });
      return {
        builtAt: snapshot.builtAt,
        fanCount: snapshot.fanCount,
        entries: snapshot.entries.map((entry) => ({
          platformUserId: entry.platformUserId,
          username: entry.username,
          displayName: entry.displayName,
          grossMills: entry.grossMills,
        })),
      };
    } catch (error) {
      throw this.toHubError(error);
    }
  }

  async testConnection(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<AgencyHubConnectionTestResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = resolveHubBearer(settings);

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

  async submitAiUsageBatch({
    settings,
    events,
    signal,
  }: AgencyHubSubmitAiUsageBatchInput): Promise<AgencyHubSubmitAiUsageBatchResult> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = resolveHubBearer(settings);

    if (!baseUrl) {
      return {
        status: 'skipped',
        reason: 'missing_base_url',
        baseUrl: null,
      };
    }
    if (!apiKey) {
      return {
        status: 'skipped',
        reason: 'missing_api_key',
        baseUrl,
      };
    }
    if (!events.length) {
      return {
        status: 'skipped',
        reason: 'empty_batch',
        baseUrl,
      };
    }
    if (events.length > AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS) {
      return {
        status: 'failed',
        reason: 'too_many_events',
        baseUrl,
      };
    }
    if (!await this.hasHostPermission(baseUrl)) {
      return {
        status: 'skipped',
        reason: 'missing_host_permission',
        baseUrl,
      };
    }

    try {
      const response = await this.postAiUsageBatch(
        baseUrl,
        apiKey,
        events,
        signal,
      );
      return {
        status: 'submitted',
        reason: 'submitted',
        baseUrl,
        response,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          status: 'failed',
          reason: 'aborted',
          baseUrl,
        };
      }

      return {
        status: 'failed',
        reason: error instanceof ChatGooseError
          ? error.key
          : error instanceof Error
            ? error.message
            : 'unknown_error',
        baseUrl,
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
    const apiKey = resolveHubBearer(settings);

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
    const apiKey = resolveHubBearer(settings);

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
