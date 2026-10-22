import {
  KERNEL_CONTRACT_HASH,
  KernelApiError,
  createClient,
  fetchVoiceNoteAudio as fetchVoiceNoteAudioResponse,
  routeSchemas,
  type KernelClientOptions,
} from '@kernel/sdk';
// The vendor pin's provenance. `sourceCommit` is the ONLY SDK identity the
// cabinet shows next to the contract hash; the exported KERNEL_SDK_VERSION is
// the SDK package version, not the core build, so it is deliberately not shown.
import kernelSdkVendorManifest from '../../vendor/kernel-sdk/kernel-sdk.vendor.json';
import { clientVersionHeaders } from '../shared/client-version.js';
import {
  AGENCY_HUB_PROFILE_MAX_BYTES,
  buildAgencyHubOriginPattern,
  hasAgencyHubSyncMetadata,
  measureUtf8Bytes,
  normalizeAgencyHubBaseUrl,
  normalizeAgencyHubUsername,
} from '../shared/agency-hub.js';
import {
  AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS,
  SPENDERS_KERNEL_LIMIT,
  SPENDERS_KERNEL_LEGACY_LIMIT,
} from '../shared/constants.js';
import {
  ChatGooseError,
  createUserError,
  toUserError,
} from '../shared/errors.js';
import { logWarn } from '../shared/log.js';
import {
  healRevokedHubSession,
  selfHealingUnauthorizedReason,
} from './hub-custody.js';
import { isRecapStatusResponse } from '../shared/protocol.js';
import type {
  AgencyHubAiUsageBatchResponse,
  AgencyHubAiUsageEvent,
  AgencyHubConnectionTestResponse,
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AgencyHubSummarySyncMetadata,
  RecapStatusResponse,
  Settings,
  SpendersStreamState,
  UserFacingError,
  VoiceNoteStatusView,
} from '../shared/types.js';

interface AgencyHubPageSummary {
  label: string;
  platform: 'fansly' | 'onlyfans';
  username: string | null;
  capabilities?: {
    voiceNotes: boolean;
  };
}

export interface AgencyHubResolvedPage {
  pageLabel: string;
  voiceNotesCapable: boolean;
}

interface AgencyHubProfileRecord {
  version: number;
  body: string;
  source: 'chatmuse';
  createdAt: string;
  /** Scan generation time (core #136); absent/null on rows written before
   * the kernel learned the field. */
  sourceGeneratedAt?: string | null;
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

/** The hub bearer: the device-bound credential «Войти» minted, and nothing
 * else. The legacy-key fallback went out with v17 (E123) — a client that finds
 * no sign-in here asks the chatter to sign in, it does not reach for a second
 * credential class. */
export function resolveHubBearer(
  settings: Pick<Settings, 'agencyHubDeviceToken'>,
): string {
  // Null-safe: legacy runtime message shapes may omit the token field.
  return (settings.agencyHubDeviceToken ?? '').trim();
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
  /** Last-moment guard after page resolution and immediately before PUT. */
  beforeCommit?: () => boolean | Promise<boolean>;
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
  /** When the stored profile's Scan actually ran (core #136); absent on rows
   * written before the kernel learned the field. createdAtMs is only the hub
   * APPEND time. */
  sourceGeneratedAtMs?: number;
  fanAccountId?: string;
}

export interface AgencyHubSubmitAiUsageBatchInput {
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>;
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

/** The server's actual response body beats the SDK's synthetic
 * "GET /path failed with NNN" message as diagnostic material. */
function hubResponseSnippet(error: KernelApiError): string {
  if (typeof error.body === 'string' && error.body.trim()) {
    return error.body.slice(0, 400);
  }
  if (error.body && typeof error.body === 'object') {
    try {
      return JSON.stringify(error.body).slice(0, 400);
    } catch {
      // Fall through to the SDK message.
    }
  }
  return error.message.slice(0, 400);
}

/** Core versions before decision #142 reject the expanded request with this
 * exact Fastify/Zod response. Keep the match deliberately strict: this is
 * rollback compatibility, not a generic retry for validation failures. */
function isLegacyTopSpendersLimitError(error: unknown, requestedLimit: number): boolean {
  if (
    requestedLimit !== SPENDERS_KERNEL_LIMIT ||
    !(error instanceof KernelApiError) ||
    error.category !== 'validation' ||
    error.status !== 400 ||
    error.code !== 'Bad Request' ||
    !error.body ||
    typeof error.body !== 'object'
  ) {
    return false;
  }
  const body = error.body as Record<string, unknown>;
  return Object.keys(body).length === 3 &&
    body.error === 'Bad Request' &&
    body.message === 'querystring/limit Too big: expected number to be <=500' &&
    body.statusCode === 400;
}

export class AgencyHubClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    fetchImpl: FetchLike = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  ) {
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
  private sdkOptions(
    baseUrl: string,
    bearer: string,
    signal: AbortSignal,
  ): KernelClientOptions {
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      auth: { mode: 'bearer', token: () => bearer },
      headers: clientVersionHeaders(),
      fetch: (input, init) => this.fetchImpl(input, { ...init, signal }),
      // §4.5 self-healing. The wipe is fire-and-forget on purpose: it re-checks
      // under the custody FIFO that the bearer THIS request sent is still the
      // stored one, so a sign-in that landed meanwhile survives, and a 401 the
      // server gave no reason for never gets here at all.
      onAuthError: (error) => {
        if (selfHealingUnauthorizedReason(error)) {
          void healRevokedHubSession(bearer);
        }
      },
    };
  }

  private sdkFor(baseUrl: string, bearer: string, signal: AbortSignal) {
    return createClient(this.sdkOptions(baseUrl, bearer, signal));
  }

  async followerOutreachAttempt(settings: Settings, pageLabel: string, body: {
    fanRef: string; attemptId: string; action: 'reserve' | 'dispatch' | 'sent'; messageRef?: string;
  }, signal: AbortSignal) {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) throw new ChatGooseError('hub_missing_api_key');
    try {
      return await this.sdkFor(baseUrl, bearer, signal).followerOutreachAttempt({ params: { pageLabel }, body });
    } catch (error) { throw await this.toHubError(error, 'follower outreach', bearer); }
  }

  /** Map SDK failures back onto the public contract the callers already
   * handle: HTTP errors become ChatGooseError keys, aborts resurface as
   * AbortError DOMExceptions, and plain network failures rethrow as bare
   * Errors so their message survives into the result's `reason`. */
  private async toHubError(error: unknown, op: string, bearer?: string): Promise<ChatGooseError> {
    if (error instanceof KernelApiError) {
      if (error.category === 'network') {
        if (error.code === 'aborted') {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        logWarn(`Agency Hub ${op} failed`, { network: error.message });
        throw new Error(error.message);
      }
      const responseSnippet = hubResponseSnippet(error);
      logWarn(`Agency Hub ${op} failed`, {
        status: error.status ?? 0,
        response: responseSnippet,
      });
      const details = { status: error.status ?? 0, responseSnippet };
      if (error.status === 401 || error.status === 403) {
        // §4.5: «Сессия устройства завершена» is a claim about THIS device, so
        // it is only made when the device was actually signed out. The wipe
        // re-checks the digest under the custody FIFO, so a 401 that belonged to
        // a bearer a newer sign-in has already replaced heals nothing — and then
        // the honest card is the fail-closed one, not a lie about a live session.
        const healed = selfHealingUnauthorizedReason(error) && bearer
          ? await healRevokedHubSession(bearer)
          : false;
        // Both keys constructed LITERALLY: the registry-producer gate reads the
        // source for `new ChatGooseError('key')`, and a computed key would make
        // a live registry entry look orphaned.
        return healed
          ? new ChatGooseError('hub_session_ended', { details })
          : new ChatGooseError('hub_unauthorized', { details });
      }
      return new ChatGooseError('hub_request_failed', { details });
    }
    if (error instanceof ChatGooseError || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    logWarn(`Agency Hub ${op} failed`, {
      error: error instanceof Error ? error.message.slice(0, 400) : String(error),
    });
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
      throw await this.toHubError(error, 'pages list', bearer);
    }
  }

  private resolvePage(
    pages: AgencyHubPageSummary[],
    pageUsername: string | null,
  ): AgencyHubPageSummary | null {
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

    const match = matches[0];
    const pageLabel = match?.label?.trim() ?? '';
    return match && pageLabel ? match : null;
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
      throw await this.toHubError(error, 'conversation profile fetch', apiKey);
    }
  }

  private async putFanProfile(
    baseUrl: string,
    apiKey: string,
    pageLabel: string,
    platformUserId: string,
    body: string,
    signal: AbortSignal,
    generatedAtMs?: number,
  ): Promise<void> {
    try {
      await this.sdkFor(baseUrl, apiKey, signal).upsertFanProfile({
        params: { pageLabel, platformUserId },
        // generatedAtMs = when the Scan ran (core #136): without it a delayed
        // re-push would reset the dossier's age kernel-side (created_at is the
        // append time). Old kernels ignore the extra key (non-strict schema).
        body: { body, ...(generatedAtMs ? { generatedAtMs } : {}) },
      });
    } catch (error) {
      throw await this.toHubError(error, 'fan profile push', apiKey);
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
      throw await this.toHubError(error, 'AI usage batch', apiKey);
    }
  }

  /** The hub bootstrap's `capabilities` (live images ask for `live-images-v1`).
   * Read-only on the hub; throws like every other hub read. */
  async hubCapabilities(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<string[]> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) throw new ChatGooseError('hub_missing_api_key');
    try {
      return (await this.sdkFor(baseUrl, bearer, signal).clientBootstrap()).capabilities;
    } catch (error) {
      throw await this.toHubError(error, 'bootstrap', bearer);
    }
  }

  /** Stage 32: the feature lane needs the kernel page label for the signed-in
   * Fansly creator. Exact-match rule over the SDK pages list (the profile
   * push's resolvePageLabel, exposed). Null means a configured, reachable Hub
   * had no page match; preflight failures keep their own actionable codes. */
  async resolvePageLabelForUsername(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageUsername: string | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    return (await this.resolvePageForUsername(settings, pageUsername, signal))?.pageLabel ?? null;
  }

  /** Resolve the current creator to its assigned page and retain the optional
   * voice-notes capability hint. Missing capability data is deliberately
   * false; POST /voice-notes remains the authoritative admission check. */
  async resolvePageForUsername(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageUsername: string | null,
    signal: AbortSignal,
  ): Promise<AgencyHubResolvedPage | null> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl) throw new ChatGooseError('hub_invalid_url');
    if (!bearer) throw new ChatGooseError('hub_missing_api_key');
    if (!await this.hasHostPermission(baseUrl)) {
      throw new ChatGooseError('hub_missing_permission');
    }
    let pages: AgencyHubPageSummary[];
    try {
      pages = await this.listVisiblePages(baseUrl, bearer, signal);
    } catch (error) {
      if (
        error instanceof ChatGooseError ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) throw error;
      // Wrapper-style Hub operations retain raw network reasons, but this is a
      // throwing feature-lane preflight: keep it inside the Hub error domain so
      // runtime UI cannot collapse it to CG-UNK-01.
      throw new ChatGooseError('hub_request_failed', {
        details: {
          status: 0,
          responseSnippet: error instanceof Error ? error.message.slice(0, 400) : '',
        },
      });
    }
    const page = this.resolvePage(pages, pageUsername);
    if (!page) {
      return null;
    }
    return {
      pageLabel: page.label.trim(),
      voiceNotesCapable: page.capabilities?.voiceNotes === true,
    };
  }

  private async resolveVoiceCallContext(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
  ): Promise<{ baseUrl: string; bearer: string }> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl) throw new ChatGooseError('hub_invalid_url');
    if (!bearer) throw new ChatGooseError('hub_missing_api_key');
    if (!await this.hasHostPermission(baseUrl)) {
      throw new ChatGooseError('hub_missing_permission');
    }
    return { baseUrl, bearer };
  }

  /** Voice-note methods intentionally preserve KernelApiError bodies and raw
   * error responses for the dedicated service, which maps structured voice
   * codes and auth statuses onto its port lane. */
  async createVoiceNote(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageLabel: string,
    body: {
      clientRequestId: string;
      conversationRef: string;
      sourceGenerationRef: string;
      script: string;
    },
    signal: AbortSignal,
  ): Promise<VoiceNoteStatusView> {
    const { baseUrl, bearer } = await this.resolveVoiceCallContext(settings);
    return await this.sdkFor(baseUrl, bearer, signal).voiceNoteCreate({
      params: { pageLabel },
      body,
    });
  }

  async getVoiceNoteStatus(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageLabel: string,
    id: number,
    signal: AbortSignal,
  ): Promise<VoiceNoteStatusView> {
    const { baseUrl, bearer } = await this.resolveVoiceCallContext(settings);
    return await this.sdkFor(baseUrl, bearer, signal).voiceNoteStatus({
      params: { pageLabel, id },
    });
  }

  async fetchVoiceNoteAudio(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageLabel: string,
    id: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const { baseUrl, bearer } = await this.resolveVoiceCallContext(settings);
    return await fetchVoiceNoteAudioResponse(
      this.sdkOptions(baseUrl, bearer, signal),
      { pageLabel, id },
    );
  }

  /** Coach recap-status read (spec §3/§5): the freshest usable full + short
   * fan-summary recap for one conversation — metadata only, NO generation and
   * NO AI spend. Honest availability (E43/E45): ONLY a valid 200 confirms
   * reality — then `state: 'ok'` with slots that may be null (genuinely no recap).
   * A 404 proves only that the status could NOT be read (an old Hub without the
   * route, or a page deleted mid-flight), and any other failure (timeout, 401/403,
   * hub_request_failed) likewise means "could not check" — all of these report
   * `state: 'unavailable'` (404 returned here; the rest throw and the caller
   * coalesces to unavailable), which the consumer must NOT render as "no recap".
   * Unlike `getConversationProfile`, a 404 is deliberately NOT treated as a
   * confirmed domain "none". Canonical identity (§5): `conversationRef = groupId`,
   * `fanRef = fanAccountId`. */
  async getRecapStatus(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    params: {
      pageLabel: string;
      conversationRef: string;
      fanRef?: string | null;
      personaDefinitionId: string;
    },
    signal: AbortSignal,
  ): Promise<RecapStatusResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer || !await this.hasHostPermission(baseUrl)) {
      // Not configured / no host permission — the Hub was never reached, so the
      // caller must NOT read this as "no recap" (E43 honest empty-states).
      return { state: 'unavailable', full: null, short: null };
    }
    try {
      const response = await this.sdkFor(baseUrl, bearer, signal).aiRecapStatus({
        query: {
          pageLabel: params.pageLabel,
          conversationRef: params.conversationRef,
          ...(params.fanRef ? { fanRef: params.fanRef } : {}),
          personaDefinitionId: params.personaDefinitionId,
        },
      });
      // Defense-in-depth at this untrusted boundary (item 4): the SDK already
      // safeParses the 200 against aiRecapStatusResponseSchema, but re-validate
      // the shape here so a drifted/old Hub whose reply somehow slips through can
      // never reach the consumer as a trusted 'ok' — fail closed to unavailable.
      if (!isRecapStatusResponse(response)) {
        return { state: 'unavailable', full: null, short: null };
      }
      // Only a VALID 200 confirms reality — then null slots genuinely mean "no recap".
      return { state: 'ok', full: response.full, short: response.short };
    } catch (error) {
      // A 404 only proves the endpoint/conversation could not be READ (an old Hub
      // without the route, or a page deleted between the pageLabel resolve and
      // this call) — it does NOT confirm "no recap". Only a valid 200 can. So a
      // 404, like any other failure, reports 'unavailable', never confirmed-empty.
      // (Core signals genuine absence as a 200 with null slots, never a 404.)
      if (error instanceof KernelApiError && error.status === 404) {
        return { state: 'unavailable', full: null, short: null };
      }
      // Timeout / hub_request_failed / 401/403 → could not check; surface as a
      // throw so the caller reports 'unavailable', not "no recap".
      throw await this.toHubError(error, 'recap status fetch', bearer);
    }
  }

  /** Stage 32 Task 4: one kernel query replaces the board's Fansly earnings
   * sweep. Observation-honest: builtAt = the newest observation across the
   * page/window projection, not a coherent timestamp shared by returned rows.
   * `window` is 'lifetime' or a 'YYYY-MM' calendar month (kernel contract). */
  async fetchTopSpenders(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    pageLabel: string,
    window: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    builtAt: string | null;
    fanCount: number;
    source: {
      streamState: SpendersStreamState;
      lastSyncedAt: string | null;
      consecutiveFailures: number | null;
    };
    entries: Array<{
      platformUserId: string;
      username: string | null;
      displayName: string | null;
      grossMills: number;
      /** ISO time the kernel first failed to find this account on Fansly;
       * null = alive, or a kernel that predates the field. */
      deletedAt: string | null;
    }>;
  }> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) {
      throw new ChatGooseError('hub_missing_api_key');
    }
    const fetchSnapshot = async (requestLimit: number) =>
      await this.sdkFor(baseUrl, bearer, signal).pageTopSpenders({
        params: { pageLabel },
        query: { window, limit: requestLimit },
      });
    try {
      const snapshot = await fetchSnapshot(limit).catch(async (error: unknown) => {
        if (!isLegacyTopSpendersLimitError(error, limit)) throw error;
        logWarn('Agency Hub top spenders uses the pre-#142 limit; retrying compatibly', {
          requestedLimit: limit,
          fallbackLimit: SPENDERS_KERNEL_LEGACY_LIMIT,
        });
        return await fetchSnapshot(SPENDERS_KERNEL_LEGACY_LIMIT);
      });
      return {
        builtAt: snapshot.builtAt,
        fanCount: snapshot.fanCount,
        source: {
          streamState: snapshot.source.streamState,
          lastSyncedAt: snapshot.source.lastSyncedAt,
          consecutiveFailures: snapshot.source.consecutiveFailures,
        },
        entries: snapshot.entries.map((entry) => ({
          platformUserId: entry.platformUserId,
          username: entry.username,
          displayName: entry.displayName,
          grossMills: entry.grossMills,
          // `?? null` is mandatory, not defensive: the contract declares this
          // field optional so a kernel deployed before it still validates, and
          // the kernel ships separately from this extension.
          deletedAt: entry.deletedAt ?? null,
        })),
      };
    } catch (error) {
      throw await this.toHubError(error, 'top spenders fetch', bearer);
    }
  }

  /** Global persona bodies are admin-only. Chatter clients receive metadata. */
  private async resolvePersonaCallContext(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
  ): Promise<{ baseUrl: string; bearer: string }> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) {
      throw new ChatGooseError('hub_missing_api_key');
    }
    if (!await this.hasHostPermission(baseUrl)) {
      throw new ChatGooseError('hub_missing_permission');
    }
    return { baseUrl, bearer };
  }

  async fetchAiPersonaCatalog(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<Array<{
    key: string;
    displayName: string;
    version: number;
    definitionId: string;
    status: 'active' | 'archived';
  }>> {
    const { baseUrl, bearer } = await this.resolvePersonaCallContext(settings);
    try {
      const response = await this.sdkFor(baseUrl, bearer, signal).aiPersonaCatalog();
      return response.personas;
    } catch (error) {
      throw await this.toHubError(error, 'persona catalog', bearer);
    }
  }

  /** «Выйти» sign-out revoke. The DELETE op is device-token-only — it rejects an
   * API-key bearer — so the bearer is the device token itself, never
   * resolveHubBearer (which prefers the token but could fall back to the legacy
   * key). Resolves 'revoked' (200) or 'already-invalid' (401/403, or NO token to
   * revoke). Abort/network/5xx THROW — and so does a MISSING base URL while a
   * token is still present (the server token stays live, so revocation is
   * unconfirmed): the caller reports "unreachable" and wipes locally regardless,
   * so revocation is best-effort, never a blocker. Crucially, a cleared base URL
   * is NOT 'already-invalid' — that outcome is reserved for a token the hub
   * actually rejected (or the absence of any token). */
  async revokeDeviceToken(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<'revoked' | 'already-invalid'> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const deviceToken = (settings.agencyHubDeviceToken ?? '').trim();
    if (!deviceToken) {
      // No token to revoke — an honest already-invalid, and nothing to send.
      return 'already-invalid';
    }
    if (!baseUrl) {
      // A token IS present but there is no address to reach the hub: the server
      // token stays LIVE, so revocation is UNCONFIRMED — never 'already-invalid'
      // (that would falsely claim a 401 the hub never sent). Throw so the handler
      // maps it to 'unreachable' and the token dies by sliding-expiry.
      throw new Error('Agency Hub base URL missing — device token revoke unreachable');
    }
    try {
      await this.sdkFor(baseUrl, deviceToken, signal).authRevokeCurrentDeviceToken();
      return 'revoked';
    } catch (error) {
      if (error instanceof KernelApiError && (error.status === 401 || error.status === 403)) {
        // Already dead server-side — an honest sign-out, not a failure.
        return 'already-invalid';
      }
      // Abort/network/other-status: revocation is UNCONFIRMED. Surface it; the
      // handler maps every throw to 'unreachable'.
      logWarn('Agency Hub device token revoke failed', {
        status: error instanceof KernelApiError ? error.status ?? 0 : 0,
      });
      throw error;
    }
  }

  /** Public /health for the status row. DEGRADED is a declared 503 whose body
   * the TYPED client throws before parsing — so read the raw Response (200 AND
   * 503 both carry the body) and validate with the vendored 200 schema, whose
   * status enum already covers 'degraded'. Health needs no bearer; it still
   * needs the base URL and host permission (the extension can only reach the
   * hub origin with the granted permission). */
  async checkHealth(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<AgencyHubHealthResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    if (!baseUrl) return { ok: false, reason: 'no_base_url' };
    if (!await this.hasHostPermission(baseUrl)) return { ok: false, reason: 'no_permission' };
    try {
      const response = await this.sdkFor(baseUrl, resolveHubBearer(settings), signal).raw('health');
      const json: unknown = await response.json().catch(() => null);
      const parsed = routeSchemas.health.response[200].safeParse(json);
      if (!parsed.success) return { ok: false, reason: 'unreachable' };
      return {
        ok: true,
        status: parsed.data.status,
        dbLatencyMs: parsed.data.checks.database.latencyMs,
        contractHash: parsed.data.contractHash,
        // Stamped background-side so the options bundle imports no SDK (E41).
        sdkContractHash: KERNEL_CONTRACT_HASH,
        sdkSourceCommit: kernelSdkVendorManifest.sourceCommit ?? null,
      };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }

  /** Authenticated identity for the «Доступ» row. A 401/403 is the credential
   * being rejected (distinct from a DOWN hub); no bearer means nothing to send.
   * A missing host permission is its OWN reason — NOT unreachable — so the
   * renderer keeps the credential badge neutral and lets the Hub row own the
   * grant prompt (health ≠ credential). */
  async checkIdentity(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<AgencyHubIdentityResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    // A missing credential and a missing base URL are DIFFERENT verdicts: with a
    // bearer present but no address, there is nothing wrong with the credential —
    // the hub is simply unaddressed. Conflating them into `no_credential` paints
    // the Доступ row a false red «нет credential».
    if (!bearer) return { ok: false, reason: 'no_credential' };
    if (!baseUrl) return { ok: false, reason: 'no_base_url' };
    if (!await this.hasHostPermission(baseUrl)) return { ok: false, reason: 'no_permission' };
    try {
      const me = await this.sdkFor(baseUrl, bearer, signal).me();
      return {
        ok: true,
        username: me.user.username,
        role: me.user.role,
        // FANSLY pages only. A chatter can hold pages on both platforms (the
        // account is platform-neutral — that is the whole point of E123), and
        // this row is labelled «Страницы Fansly»: listing an OnlyFans page here
        // would promise something this client cannot open.
        pages: me.user.assignedPages
          .filter((page) => page.platform === 'fansly')
          .map((page) => page.label),
      };
    } catch (error) {
      if (error instanceof KernelApiError && (error.status === 401 || error.status === 403)) {
        return { ok: false, reason: 'unauthorized' };
      }
      return { ok: false, reason: 'unreachable' };
    }
  }

  async testConnection(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
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

      // One credential class, one rejection card (E123): the registry entry
      // already says «войдите заново», so there is nothing left to disambiguate
      // — the old copy existed only to name WHICH of two credentials was sent.
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
    beforeCommit,
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
      const pageLabel = this.resolvePage(pages, normalizedPageUsername)?.label.trim() ?? null;
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

      if (beforeCommit && !await beforeCommit()) {
        return {
          status: 'skipped',
          reason: 'stale_context',
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
        generatedAt,
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
      const pageLabel = this.resolvePage(pages, normalizedPageUsername)?.label.trim() ?? null;
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
      const sourceGeneratedAtMs = profileResponse.profile.sourceGeneratedAt
        ? Date.parse(profileResponse.profile.sourceGeneratedAt)
        : Number.NaN;
      const fanAccountId = profileResponse.fan.platformUserId.trim();

      return {
        status: 'fetched',
        reason: 'fetched',
        baseUrl,
        pageLabel,
        body,
        ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
        ...(Number.isFinite(sourceGeneratedAtMs) ? { sourceGeneratedAtMs } : {}),
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
