import type { TraceScope } from './followers-trace.js';
import {
  FANSLY_PAGINATION_DELAY_MS,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS,
  FANSLY_PAGE_LIMIT,
  FANSLY_REQUEST_TIMEOUT_MS,
  FANSLY_RETRY_DELAYS_MS,
  FANSLY_RETRY_MAX_BACKOFF_MS,
} from '../shared/constants.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import { aggregateEarnings } from '../shared/earnings.js';
import { ChatGooseError } from '../shared/errors.js';
import {
  estimateTargetPages,
  extractOldestMessageId,
} from '../shared/transcript.js';
import { recordAccountPresence } from './account-presence.js';

/** Retry-After header → ms (seconds or HTTP-date form). Relocated from the
 * deleted llm-stream-utils (Stage 32) — Fansly rate limits still use it. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}
import type {
  PpvAttachmentRequest,
  PurchaseEvidenceOverride,
} from '../shared/transcript.js';
import type {
  AggregatedEarnings,
  EarningsRow,
  FanslyAccountMediaOrder,
  FanslyAccountResponse,
  FanslyMediaOrderHistoryResponse,
  FanslyMessagingGroupsResponse,
  FanslyMessagePageResponse,
  FanslyMessage,
  FanslySubscriberSubscriptionRecord,
  FanslySubscribersResponse,
  FanSubscriptionContext,
  FanSubscriptionSource,
  MonthlyEarningsRow,
  RouteKey,
  SessionTemplate,
  SubscriptionLookupMode,
} from '../shared/types.js';
import type { SessionStore } from './session-store.js';

const MESSAGING_GROUPS_PAGE_SIZE = 100;
// Bound the messaging-groups walk so a creator with tens of thousands of
// conversations can't burn the whole operation budget here before the
// subscribers fallback runs.
const MESSAGING_GROUPS_MAX_PAGES = 20;
const SUBSCRIBERS_PAGE_SIZE = 100;
const SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1000;
const ORDER_TYPE_SINGLE = 1;
const ORDER_TYPE_BUNDLE = 2;

type MediaPurchaseStatus = 'purchased' | 'not-purchased';

interface CachedMediaPurchaseStatus {
  expiresAt: number;
  status: MediaPurchaseStatus;
}

interface MediaPurchaseCheckResult {
  request: PpvAttachmentRequest;
  status: MediaPurchaseStatus;
}

function withNgswBypass(url: URL): URL {
  url.searchParams.set('ngsw-bypass', 'true');
  return url;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    const onAbort = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}

export interface MessageLoadResult {
  pages: FanslyMessagePageResponse[];
  pagesLoaded: number;
  targetPages: number;
  /** True when pagination stopped because a page came back short/empty (the
   * provider's history end was reached); false when it stopped because
   * `requestedCount` was satisfied (more history may exist below the window).
   * Feeds the coach `transcriptCoverage` derivation (spec §5/§6). */
  reachedEnd: boolean;
}

export interface MessageLoadProgress {
  currentPage: number;
  targetPages: number;
  pageMessageCount: number;
  collectedCount: number;
}

export type SubscriptionLookupTraceEvent =
  | { type: 'cache-hit' }
  | { type: 'cache-miss' }
  | { type: 'cache-only-skip' }
  | { type: 'groups-start' }
  | { type: 'groups-hit' }
  | { type: 'groups-miss' }
  | { type: 'groups-error'; code: string }
  | { type: 'subscribers-start' }
  | { type: 'subscribers-hit' }
  | { type: 'subscribers-miss' };

interface CachedSubscriberSubscription {
  expiresAt: number;
  value: FanSubscriptionContext | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampToIso(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;
}

function extractOrderHistoryRows(
  response: FanslyMediaOrderHistoryResponse,
): FanslyAccountMediaOrder[] | null {
  const raw = response as {
    accountMediaOrderHistory?: unknown;
    aggregationData?: {
      accountMediaOrders?: unknown;
    };
  };
  const direct = raw.accountMediaOrderHistory;
  const aggregated = raw.aggregationData?.accountMediaOrders;

  if (direct !== undefined && !Array.isArray(direct)) {
    return null;
  }
  if (aggregated !== undefined && !Array.isArray(aggregated)) {
    return null;
  }
  if (direct === undefined && aggregated === undefined) {
    return null;
  }

  return [
    ...(Array.isArray(direct) ? direct : []),
    ...(Array.isArray(aggregated) ? aggregated : []),
  ].filter((row): row is FanslyAccountMediaOrder => Boolean(row && typeof row === 'object'));
}

function orderMatchesPurchaseRequest(
  order: FanslyAccountMediaOrder,
  request: PpvAttachmentRequest,
  fanAccountId: string,
): boolean {
  if (order.accountId !== fanAccountId) {
    return false;
  }

  if (request.kind === 'single') {
    return (
      order.accountMediaId === request.contentId &&
      order.accountMediaBundleId == null &&
      (order.type == null || order.type === ORDER_TYPE_SINGLE)
    );
  }

  if (order.accountMediaBundleId) {
    return (
      order.accountMediaBundleId === request.contentId &&
      order.type !== ORDER_TYPE_SINGLE
    );
  }

  return order.type === ORDER_TYPE_BUNDLE && order.accountMediaId === request.contentId;
}

function uniquePurchaseRequests(requests: PpvAttachmentRequest[]): PpvAttachmentRequest[] {
  const seen = new Set<string>();
  const unique: PpvAttachmentRequest[] = [];
  for (const request of requests) {
    const contentId = request.contentId.trim();
    if (!contentId) {
      continue;
    }
    const key = `${request.kind}:${contentId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ kind: request.kind, contentId });
  }
  return unique;
}

function normalizeSubscriberSubscription(
  record: FanslySubscriberSubscriptionRecord,
  source: FanSubscriptionSource,
): FanSubscriptionContext {
  return {
    source,
    subscriptionId: record.id,
    subscriberAccountId: record.subscriberId,
    status: record.status,
    subscriptionTierId: record.subscriptionTierId,
    subscriptionTierName: normalizeOptionalString(record.subscriptionTierName),
    planId: normalizeOptionalString(record.planId),
    price: record.price,
    renewPrice: normalizeOptionalNumber(record.renewPrice),
    autoRenew:
      record.autoRenew === null || record.autoRenew === undefined ? null : record.autoRenew > 0,
    billingCycle: normalizeOptionalNumber(record.billingCycle),
    giftCodeId: normalizeOptionalString(record.giftCodeId),
    promoId: normalizeOptionalString(record.promoId),
    promoPrice: normalizeOptionalNumber(record.promoPrice),
    promoDuration: normalizeOptionalNumber(record.promoDuration),
    promoStatus: normalizeOptionalNumber(record.promoStatus),
    promoStartsAtIso: timestampToIso(record.promoStartsAt),
    promoEndsAtIso: timestampToIso(record.promoEndsAt),
    renewDateIso: timestampToIso(record.renewDate),
    endsAtIso: timestampToIso(record.endsAt),
    createdAtIso: timestampToIso(record.createdAt),
  };
}

export class FanslyClient {
  private readonly subscriberSubscriptionCache = new Map<string, CachedSubscriberSubscription>();
  private readonly mediaPurchaseVerificationCache = new Map<string, CachedMediaPurchaseStatus>();

  constructor(private readonly sessionStore: SessionStore) {}

  private getSubscriberSubscriptionCacheKey(fanAccountId: string, session: SessionTemplate): string {
    return `${session.resolvedAccountId ?? session.accountId}:${fanAccountId}`;
  }

  private readCachedSubscriberSubscription(cacheKey: string): FanSubscriptionContext | null | undefined {
    const cached = this.subscriberSubscriptionCache.get(cacheKey);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.subscriberSubscriptionCache.delete(cacheKey);
      return undefined;
    }
    return cached.value;
  }

  private writeCachedSubscriberSubscription(cacheKey: string, value: FanSubscriptionContext | null): void {
    this.subscriberSubscriptionCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS,
    });
  }

  private getMediaPurchaseCacheKey(
    fanAccountId: string,
    request: PpvAttachmentRequest,
    session: SessionTemplate,
  ): string {
    return [
      session.resolvedAccountId ?? session.accountId,
      fanAccountId,
      request.kind,
      request.contentId,
    ].join(':');
  }

  private readCachedMediaPurchaseStatus(
    cacheKey: string,
  ): MediaPurchaseStatus | undefined {
    const cached = this.mediaPurchaseVerificationCache.get(cacheKey);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.mediaPurchaseVerificationCache.delete(cacheKey);
      return undefined;
    }
    return cached.status;
  }

  private writeCachedMediaPurchaseStatus(
    cacheKey: string,
    status: MediaPurchaseStatus,
  ): void {
    this.mediaPurchaseVerificationCache.set(cacheKey, {
      status,
      expiresAt: Date.now() + FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS,
    });
  }

  private async fetchEnvelope<T>(
    url: URL,
    session: SessionTemplate,
    routeKey: RouteKey,
    signal: AbortSignal,
    optional = false,
    retryPolicy: 'default' | 'none' = 'default',
    trace?: TraceScope,
  ): Promise<T> {
    const maxAttempts = retryPolicy === 'none' ? 0 : FANSLY_RETRY_DELAYS_MS.length;

    // Iterative retry: each attempt scopes its own per-request timeout so they
    // don't stack across retries (the finally clears it before the next loop).
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), FANSLY_REQUEST_TIMEOUT_MS);
      const composite = AbortSignal.any([signal, controller.signal]);
      const requestTs = String(Date.now());
      const requestUrl = withNgswBypass(url);
      const attemptTrace = trace?.start('http', { method: 'GET', path: requestUrl.pathname, query: requestUrl.search, attempt: attempt + 1, timeoutMs: FANSLY_REQUEST_TIMEOUT_MS });

      try {
        const headers = new Headers({
          authorization: session.authorization,
          'fansly-client-id': session.fanslyClientId,
          'fansly-client-ts': requestTs,
          'fansly-session-id': session.fanslySessionId,
        });

        const routeCheck = session.routeChecks[routeKey] ?? session.latestCheck;
        if (routeCheck) {
          headers.set('fansly-client-check', routeCheck);
        }

        const response = await fetch(requestUrl, {
          method: 'GET',
          headers,
          signal: composite,
          credentials: 'omit',
        });
        attemptTrace?.event('http.response', { status: response.status });

        if (response.status === 401 || response.status === 403) {
          this.sessionStore.markDisconnected(session.accountId);
          throw new ChatGooseError('session_expired', undefined, { status: response.status });
        }

        const retryAfterMs = response.status === 429
          ? parseRetryAfterMs(response.headers.get('retry-after'))
          : undefined;

        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          const backoff = retryAfterMs !== undefined
            ? Math.min(retryAfterMs, FANSLY_RETRY_MAX_BACKOFF_MS)
            : FANSLY_RETRY_DELAYS_MS[attempt]!;
          attemptTrace?.event('http.retry', { status: response.status, backoffMs: backoff, retryAfterMs });
          await delay(backoff, signal);
          attemptTrace?.end({ outcome: 'retry', status: response.status });
          continue;
        }

        if (response.status === 429) {
          const retryFields = retryAfterMs !== undefined
            ? { retryAfterMs, retryAtMs: Date.now() + retryAfterMs }
            : {};
          throw new ChatGooseError('rate_limited', {
            details: { status: 429, ...retryFields },
            ...retryFields,
          });
        }

        if (!response.ok) {
          const snippet = await readResponseSnippet(response);
          const details = {
            status: response.status,
            responseSnippet: snippet,
          };
          if (optional) {
            throw new ChatGooseError('unknown_error', undefined, details);
          }
          throw new ChatGooseError('fansly_server_error', undefined, details);
        }

        const data = (await response.json()) as { success: boolean; response?: T; error?: string };
        if (!data.success || data.response === undefined) {
          if (optional) {
            throw new ChatGooseError('unknown_error');
          }
          throw new ChatGooseError('fansly_server_error');
        }

        attemptTrace?.end({ status: response.status, outcome: 'success' });
        return data.response;
      } catch (error) {
        attemptTrace?.fail(error, { callerAborted: signal.aborted, requestTimedOut: controller.signal.aborted });
        if (error instanceof ChatGooseError) {
          throw error;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        throw new ChatGooseError(optional ? 'unknown_error' : 'network_error');
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async getGroup(
    groupId: string,
    session: SessionTemplate,
    signal: AbortSignal,
    trace?: TraceScope,
  ): Promise<{ users?: Array<{ userId: string }> }> {
    return this.fetchEnvelope<{ users?: Array<{ userId: string }> }>(
      new URL(`https://apiv3.fansly.com/api/v1/group/${groupId}/`),
      session,
      'group',
      signal,
      true,
      'default',
      trace,
    );
  }

  async getFollowerPage(creatorId: string, before: string, session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<{
    followers: Array<{ id: string; followerId: string }>;
    aggregationData?: { accounts?: FanslyAccountResponse[] };
  }> {
    const url = new URL(`https://apiv3.fansly.com/api/v1/account/${creatorId}/followersnew`);
    for (const [key, value] of Object.entries({ before, after: '0', limit: '100', offset: '0', search: '', lastSeenAfter: '' })) url.searchParams.set(key, value);
    const result = await this.fetchEnvelope<{ followers: Array<{ id: string; followerId: string }>; aggregationData?: { accounts?: FanslyAccountResponse[] } }>(url, session, 'account', signal, false, 'default', trace);
    if (!Array.isArray(result.followers) || result.followers.some((v) => !v || !/^\d{1,24}$/.test(v.id) || !/^\d{1,24}$/.test(v.followerId))) throw new ChatGooseError('fansly_server_error');
    return result;
  }

  async getWelcomeDefinitions(session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<unknown> {
    return this.fetchEnvelope<unknown>(new URL('https://apiv3.fansly.com/api/v1/message/automated'), session, 'message', signal, false, 'default', trace);
  }

  /** Complete native inbox search; malformed or bounded results are not absence. */
  async findFollowerGroup(fanId: string, username: string, session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<string | null> {
    if (!username.trim()) throw new ChatGooseError('fansly_server_error');
    const seen = new Set<string>();
    for (let offset = 0; offset < 2000; offset += 100) {
      const url = new URL('https://apiv3.fansly.com/api/v1/messaging/groups');
      for (const [key, value] of Object.entries({ sortOrder: '1', flags: '0', subscriptionTierId: '', listIds: '', search: username, limit: '100', offset: String(offset) })) url.searchParams.set(key, value);
      const response = await this.fetchEnvelope<FanslyMessagingGroupsResponse>(url, session, 'messagingGroups', signal, false, 'default', trace);
      if (!Array.isArray(response.data)) throw new ChatGooseError('fansly_server_error');
      const match = response.data.find((entry) => entry.partnerAccountId === fanId);
      trace?.event('group.search-page', { offset, count: response.data.length, match: match?.groupId ?? null });
      if (match?.groupId && /^\d{1,24}$/.test(match.groupId)) return match.groupId;
      if (response.data.length < 100) return null;
      const cursor = response.data.at(-1)?.groupId;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new ChatGooseError('fansly_server_error');
  }

  /** Writes never enter fetchEnvelope's read retry loop. Any failure after
   * dispatch is ambiguous to the caller and must remain in its durable journal. */
  private async postOnce<T>(path: 'group' | 'message', body: unknown, session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<T> {
    const headers = new Headers({
      authorization: session.authorization,
      'fansly-client-id': session.fanslyClientId,
      'fansly-client-ts': String(Date.now()),
      'fansly-session-id': session.fanslySessionId,
      'content-type': 'application/json',
    });
    const check = session.routeChecks[path] ?? session.latestCheck;
    if (check) headers.set('fansly-client-check', check);
    const requestUrl = withNgswBypass(new URL(`https://apiv3.fansly.com/api/v1/${path}`));
    const attemptTrace = trace?.start('http', { method: 'POST', path: requestUrl.pathname, query: requestUrl.search, attempt: 1, retry: false, timeoutMs: FANSLY_REQUEST_TIMEOUT_MS });
    try {
      const response = await fetch(requestUrl, {
        method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(FANSLY_REQUEST_TIMEOUT_MS)]),
      });
      attemptTrace?.event('http.response', { status: response.status });
      if (!response.ok) throw new ChatGooseError('fansly_server_error');
      const envelope = await response.json() as { success?: boolean; response?: T };
      if (envelope.success !== true || !envelope.response) throw new ChatGooseError('fansly_server_error');
      attemptTrace?.end({ status: response.status, outcome: 'success' });
      return envelope.response;
    } catch (error) { attemptTrace?.fail(error); throw error; }
  }

  async createFollowerGroup(fanId: string, creatorId: string, session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<string> {
    const group = await this.postOnce<{ id?: string; users?: Array<{ userId: string }> }>('group', {
      users: [{ userId: fanId, permissionFlags: 0 }, { userId: creatorId, permissionFlags: 0 }],
      recipients: [], lastMessage: null, userSettings: null, type: 1,
    }, session, signal, trace);
    if (!group.id || !/^\d{1,24}$/.test(group.id) || group.users?.length !== 2 || !group.users.some((v) => v.userId === fanId) || !group.users.some((v) => v.userId === creatorId)) throw new ChatGooseError('fansly_server_error');
    return group.id;
  }

  async sendFollowerMessage(groupId: string, text: string, creatorId: string, session: SessionTemplate, signal: AbortSignal, trace?: TraceScope): Promise<string> {
    const message = await this.postOnce<FanslyMessage>('message', {
      type: 1, content: text, groupId, attachments: [], likes: [], scheduledFor: 0, inReplyTo: null, createdAt: Date.now(),
    }, session, signal, trace);
    if (!message.id || !/^\d{1,24}$/.test(message.id) || message.groupId !== groupId || message.senderId !== creatorId) throw new ChatGooseError('fansly_server_error');
    return message.id;
  }

  async getAuthenticatedAccountId(session: SessionTemplate, signal: AbortSignal): Promise<string> {
    const account = await this.getAuthenticatedAccount(session, signal);
    return account.id;
  }

  async getAuthenticatedAccount(
    session: SessionTemplate,
    signal: AbortSignal,
    trace?: TraceScope,
  ): Promise<FanslyAccountResponse> {
    if (
      session.resolvedAccountId &&
      (session.resolvedUsername !== null || session.resolvedDisplayName !== null)
    ) {
      trace?.event('identity.cache-hit', { creatorId: session.resolvedAccountId });
      return {
        id: session.resolvedAccountId,
        username: session.resolvedUsername,
        displayName: session.resolvedDisplayName,
      };
    }

    const response = await this.fetchEnvelope<{ account?: FanslyAccountResponse }>(
      new URL('https://apiv3.fansly.com/api/v1/account/me'),
      session,
      'account',
      signal,
      false, 'default', trace,
    );
    const accountId = response.account?.id?.trim();

    if (!accountId) {
      throw new ChatGooseError('unknown_error');
    }

    session.resolvedAccountId = accountId;
    session.resolvedUsername = response.account?.username?.trim() || null;
    session.resolvedDisplayName = response.account?.displayName?.trim() || null;

    // Second presence hook. The capture hook fires with names still null (they
    // only exist once `account/me` answers), so without this the durable record
    // would carry a bare id forever and the «Аккаунты» pane could only ever show
    // «была вчера» next to 18 digits. An identity upgrade bypasses the store's
    // 30s coalescing window; fire-and-forget so it cannot fail a resolution.
    void recordAccountPresence({
      accountId,
      username: session.resolvedUsername,
      displayName: session.resolvedDisplayName,
    }).catch(() => undefined);

    return {
      id: accountId,
      username: session.resolvedUsername,
      displayName: session.resolvedDisplayName,
    };
  }

  async getMessagePage(
    groupId: string,
    before: string | null,
    session: SessionTemplate,
    signal: AbortSignal,
    trace?: TraceScope,
  ): Promise<FanslyMessagePageResponse> {
    const url = new URL('https://apiv3.fansly.com/api/v1/message');
    url.searchParams.set('groupId', groupId);
    url.searchParams.set('limit', String(FANSLY_PAGE_LIMIT));
    if (before) {
      url.searchParams.set('before', before);
    }
    return this.fetchEnvelope<FanslyMessagePageResponse>(url, session, 'message', signal, false, 'default', trace);
  }

  private async getMediaOrderHistory(
    request: PpvAttachmentRequest,
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanslyMediaOrderHistoryResponse> {
    const url = new URL('https://apiv3.fansly.com/api/v1/media/orderhistory');
    if (request.kind === 'single') {
      url.searchParams.set('accountMediaId', request.contentId);
    } else {
      url.searchParams.set('accountMediaBundleId', request.contentId);
    }
    url.searchParams.set('accountIds', fanAccountId);
    url.searchParams.set('limit', '100');

    return this.fetchEnvelope<FanslyMediaOrderHistoryResponse>(
      url,
      session,
      'media',
      signal,
      true,
    );
  }

  private async verifyMediaPurchaseState(
    request: PpvAttachmentRequest,
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<MediaPurchaseCheckResult | null> {
    const cacheKey = this.getMediaPurchaseCacheKey(fanAccountId, request, session);
    const cached = this.readCachedMediaPurchaseStatus(cacheKey);
    if (cached) {
      return { request, status: cached };
    }

    const timeoutController = new AbortController();
    const timeout = globalThis.setTimeout(
      () => timeoutController.abort(),
      FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS,
    );
    const composite = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const response = await this.getMediaOrderHistory(
        request,
        fanAccountId,
        session,
        composite,
      );
      const rows = extractOrderHistoryRows(response);
      if (!rows) {
        return null;
      }

      const status = rows.some((order) =>
        orderMatchesPurchaseRequest(order, request, fanAccountId),
      )
        ? 'purchased'
        : 'not-purchased';
      this.writeCachedMediaPurchaseStatus(cacheKey, status);
      return { request, status };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return null;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async verifyMediaPurchaseStates(
    requests: PpvAttachmentRequest[],
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<PurchaseEvidenceOverride> {
    const uniqueRequests = uniquePurchaseRequests(requests);
    const purchasedSingleIds = new Set<string>();
    const purchasedBundleIds = new Set<string>();
    const checkedNotPurchasedSingleIds = new Set<string>();
    const checkedNotPurchasedBundleIds = new Set<string>();
    let verificationIncomplete = false;

    const results = await mapWithConcurrency(
      uniqueRequests,
      FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY,
      async (request) =>
        this.verifyMediaPurchaseState(request, fanAccountId, session, signal),
    );

    for (let index = 0; index < uniqueRequests.length; index += 1) {
      const request = uniqueRequests[index]!;
      const result = results[index] ?? null;
      if (!result) {
        verificationIncomplete = true;
        continue;
      }

      if (request.kind === 'single') {
        if (result.status === 'purchased') {
          purchasedSingleIds.add(request.contentId);
        } else {
          checkedNotPurchasedSingleIds.add(request.contentId);
        }
      } else if (result.status === 'purchased') {
        purchasedBundleIds.add(request.contentId);
      } else {
        checkedNotPurchasedBundleIds.add(request.contentId);
      }
    }

    return {
      purchasedSingleIds,
      purchasedBundleIds,
      checkedNotPurchasedSingleIds,
      checkedNotPurchasedBundleIds,
      verificationIncomplete,
    };
  }

  async getAccountNames(
    ids: string[],
    session: SessionTemplate,
    signal: AbortSignal,
    retryPolicy: 'default' | 'none' = 'default',
    trace?: TraceScope,
  ): Promise<FanslyAccountResponse[]> {
    const url = new URL('https://apiv3.fansly.com/api/v1/account');
    url.searchParams.set('ids', ids.join(','));
    const response = await this.fetchEnvelope<unknown>(
      url,
      session,
      'account',
      signal,
      true,
      retryPolicy,
      trace,
    );

    if (Array.isArray(response)) {
      return response as FanslyAccountResponse[];
    }

    if (
      response &&
      typeof response === 'object' &&
      Array.isArray((response as { accounts?: unknown[] }).accounts)
    ) {
      return (response as { accounts: FanslyAccountResponse[] }).accounts;
    }

    return [];
  }

  async getEarnings(
    fanAccountId: string,
    windowStartMs: number,
    windowEndMs: number,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<AggregatedEarnings | null> {
    const url = new URL(
      'https://apiv3.fansly.com/api/v1/account/wallets/earnings/stats/accounts',
    );
    url.searchParams.set('correlationAccountId', fanAccountId);
    url.searchParams.set('before', String(windowEndMs));
    url.searchParams.set('after', String(windowStartMs));
    // Best-effort: results are discarded on failure upstream, so don't spend
    // the retry budget on transient errors.
    const rows = await this.fetchEnvelope<EarningsRow[]>(url, session, 'earnings', signal, true, 'none');
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return aggregateEarnings(rows, fanAccountId, windowStartMs, windowEndMs);
  }

  /**
   * Enumerate the creator's conversations (newest activity first) as
   * {groupId, fanAccountId} pairs, deduped by fan, bounded to `maxFans`.
   * `truncated` is true when the cap was hit before the inbox was exhausted —
   * the spenders scan then ranks among the most-recent `maxFans` fans only.
   */
  async listFanAccounts(
    maxFans: number,
    session: SessionTemplate,
    signal: AbortSignal,
    trace?: TraceScope,
  ): Promise<{ fans: Array<{ groupId: string; fanAccountId: string }>; truncated: boolean }> {
    const fans: Array<{ groupId: string; fanAccountId: string }> = [];
    const seen = new Set<string>();
    let offset = 0;

    for (let page = 0; page < MESSAGING_GROUPS_MAX_PAGES; page += 1) {
      const url = new URL('https://apiv3.fansly.com/api/v1/messaging/groups');
      url.searchParams.set('sortOrder', '1');
      url.searchParams.set('flags', '0');
      url.searchParams.set('subscriptionTierId', '');
      url.searchParams.set('listIds', '');
      url.searchParams.set('search', '');
      url.searchParams.set('limit', String(MESSAGING_GROUPS_PAGE_SIZE));
      url.searchParams.set('offset', String(offset));

      const response = await this.fetchEnvelope<FanslyMessagingGroupsResponse>(
        url,
        session,
        'messagingGroups',
        signal,
        false, 'default', trace,
      );
      const groups = Array.isArray(response.data) ? response.data : [];
      trace?.event('inbox.page', { offset, count: groups.length });

      for (const entry of groups) {
        const fanAccountId = entry.partnerAccountId;
        if (!fanAccountId || seen.has(fanAccountId)) {
          continue;
        }
        seen.add(fanAccountId);
        fans.push({ groupId: entry.groupId, fanAccountId });
        if (fans.length >= maxFans) {
          // More conversations may remain on this or later pages.
          const moreOnPage = groups.indexOf(entry) < groups.length - 1;
          return { fans, truncated: moreOnPage || groups.length === MESSAGING_GROUPS_PAGE_SIZE };
        }
      }

      if (groups.length < MESSAGING_GROUPS_PAGE_SIZE) {
        return { fans, truncated: false };
      }

      offset += MESSAGING_GROUPS_PAGE_SIZE;
      trace?.event('inbox.delay', { delayMs: FANSLY_PAGINATION_DELAY_MS });
      await delay(FANSLY_PAGINATION_DELAY_MS, signal);
    }

    // Stopped at the page cap with full pages throughout → likely more remain.
    return { fans, truncated: true };
  }

  /**
   * Resolve the messaging groupId for a fan who is NOT among the enumerated
   * most-recent conversations: ONE bounded inbox-search request — the same
   * /messaging/groups endpoint (and its `search` param) the page's own inbox
   * search box issues, so no new Fansly egress class (E23) — matched by
   * partnerAccountId. Null = the search returned no conversation for the fan.
   */
  async findGroupIdForFan(
    fanAccountId: string,
    searchTerm: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<string | null> {
    const url = new URL('https://apiv3.fansly.com/api/v1/messaging/groups');
    url.searchParams.set('sortOrder', '1');
    url.searchParams.set('flags', '0');
    url.searchParams.set('subscriptionTierId', '');
    url.searchParams.set('listIds', '');
    url.searchParams.set('search', searchTerm);
    url.searchParams.set('limit', String(MESSAGING_GROUPS_PAGE_SIZE));
    url.searchParams.set('offset', '0');

    const response = await this.fetchEnvelope<FanslyMessagingGroupsResponse>(
      url,
      session,
      'messagingGroups',
      signal,
    );
    const groups = Array.isArray(response.data) ? response.data : [];
    for (const entry of groups) {
      if (entry.partnerAccountId === fanAccountId && entry.groupId) {
        return entry.groupId;
      }
    }
    return null;
  }

  async getMonthlyEarnings(
    fanAccountId: string,
    windowStartMs: number,
    windowEndMs: number,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<MonthlyEarningsRow[]> {
    const url = new URL(
      'https://apiv3.fansly.com/api/v1/account/wallets/earnings/monthlystats/accounts',
    );
    url.searchParams.set('correlationAccountId', fanAccountId);
    url.searchParams.set('before', String(windowEndMs));
    url.searchParams.set('after', String(windowStartMs));
    // Best-effort: discarded on failure upstream, so skip the retry budget.
    const rows = await this.fetchEnvelope<MonthlyEarningsRow[]>(url, session, 'earnings', signal, true, 'none');
    if (!Array.isArray(rows) || rows.length === 0) {
      return [];
    }
    return rows;
  }

  private async getActiveConversationSubscriptionFromMessagingGroups(
    groupId: string,
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanSubscriptionContext | null> {
    let offset = 0;

    for (let page = 0; page < MESSAGING_GROUPS_MAX_PAGES; page += 1) {
      const url = new URL('https://apiv3.fansly.com/api/v1/messaging/groups');
      url.searchParams.set('sortOrder', '1');
      url.searchParams.set('flags', '0');
      url.searchParams.set('subscriptionTierId', '');
      url.searchParams.set('listIds', '');
      url.searchParams.set('search', '');
      url.searchParams.set('limit', String(MESSAGING_GROUPS_PAGE_SIZE));
      url.searchParams.set('offset', String(offset));

      const response = await this.fetchEnvelope<FanslyMessagingGroupsResponse>(
        url,
        session,
        'messagingGroups',
        signal,
      );
      const groups = Array.isArray(response.data) ? response.data : [];
      const match = groups.find((entry) => entry.groupId === groupId);

      if (match) {
        if (match.partnerAccountId !== fanAccountId) {
          return null;
        }

        const accounts = Array.isArray(response.aggregationData?.accounts)
          ? response.aggregationData!.accounts
          : [];
        const account = accounts.find((entry) => entry.id === fanAccountId);
        const subscription = account?.subscriberSubscription;
        if (subscription?.subscriberId === fanAccountId) {
          return normalizeSubscriberSubscription(subscription, '/api/v1/messaging/groups');
        }

        return null;
      }

      if (groups.length < MESSAGING_GROUPS_PAGE_SIZE) {
        return null;
      }

      offset += MESSAGING_GROUPS_PAGE_SIZE;
      await delay(FANSLY_PAGINATION_DELAY_MS, signal);
    }

    // Page cap reached without a match: fall through to the subscribers lookup.
    return null;
  }

  private async getSubscriptionFromSubscribers(
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanSubscriptionContext | null> {
    for (const status of ['3,4', '5'] as const) {
      let offset = 0;
      let totalForStatus: number | null = null;

      while (true) {
        const url = new URL('https://apiv3.fansly.com/api/v1/subscribers');
        url.searchParams.set('before', '');
        url.searchParams.set('after', '');
        url.searchParams.set('status', status);
        url.searchParams.set('limit', String(SUBSCRIBERS_PAGE_SIZE));
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('search', '');
        url.searchParams.set('subscriptionTierId', '');

        const response = await this.fetchEnvelope<FanslySubscribersResponse>(
          url,
          session,
          'subscribers',
          signal,
        );
        const subscriptions = Array.isArray(response.subscriptions)
          ? response.subscriptions
          : [];
        const match = subscriptions.find((entry) => entry.subscriberId === fanAccountId);

        if (match) {
          return normalizeSubscriberSubscription(match, '/api/v1/subscribers');
        }

        if (response.stats) {
          totalForStatus =
            status === '3,4' ? response.stats.totalActive : response.stats.totalExpired;
        }

        if (
          subscriptions.length < SUBSCRIBERS_PAGE_SIZE ||
          (totalForStatus !== null && offset + SUBSCRIBERS_PAGE_SIZE >= totalForStatus)
        ) {
          break;
        }

        offset += SUBSCRIBERS_PAGE_SIZE;
        await delay(FANSLY_PAGINATION_DELAY_MS, signal);
      }
    }

    return null;
  }

  async getFanSubscriptionContext(
    groupId: string,
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
    lookupMode: SubscriptionLookupMode = 'full',
    onTrace?: (event: SubscriptionLookupTraceEvent) => void,
  ): Promise<FanSubscriptionContext | null> {
    const cacheKey = this.getSubscriberSubscriptionCacheKey(fanAccountId, session);
    const cached = this.readCachedSubscriberSubscription(cacheKey);
    if (cached !== undefined) {
      onTrace?.({ type: 'cache-hit' });
      return cached;
    }

    onTrace?.({ type: 'cache-miss' });
    if (lookupMode === 'cache-only') {
      onTrace?.({ type: 'cache-only-skip' });
      return null;
    }

    try {
      onTrace?.({ type: 'groups-start' });
      const activeSubscription =
        await this.getActiveConversationSubscriptionFromMessagingGroups(
          groupId,
          fanAccountId,
          session,
          signal,
        );
      if (activeSubscription) {
        onTrace?.({ type: 'groups-hit' });
        this.writeCachedSubscriberSubscription(cacheKey, activeSubscription);
        return activeSubscription;
      }

      onTrace?.({ type: 'groups-miss' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      if (error instanceof ChatGooseError && error.key === 'session_expired') {
        throw error;
      }
      onTrace?.({
        type: 'groups-error',
        code: error instanceof ChatGooseError ? error.key : 'unknown_error',
      });
    }

    onTrace?.({ type: 'subscribers-start' });
    const subscriberSubscription = await this.getSubscriptionFromSubscribers(
      fanAccountId,
      session,
      signal,
    );
    onTrace?.(
      subscriberSubscription
        ? { type: 'subscribers-hit' }
        : { type: 'subscribers-miss' },
    );
    this.writeCachedSubscriberSubscription(cacheKey, subscriberSubscription);
    return subscriberSubscription;
  }

  async loadMessages(
    groupId: string,
    requestedCount: number,
    session: SessionTemplate,
    signal: AbortSignal,
    onProgress?: (progress: MessageLoadProgress) => void,
  ): Promise<MessageLoadResult> {
    const targetPages = estimateTargetPages(requestedCount);
    const pages: FanslyMessagePageResponse[] = [];
    let collectedCount = 0;
    let before: string | null = null;
    let currentPage = 0;
    let reachedEnd = false;

    while (collectedCount < requestedCount) {
      const page = await this.getMessagePage(groupId, before, session, signal);
      const messages = page.messages ?? [];
      pages.push(page);
      currentPage += 1;
      collectedCount += messages.length;
      onProgress?.({
        currentPage,
        targetPages,
        pageMessageCount: messages.length,
        collectedCount,
      });

      before = extractOldestMessageId(messages);
      if (!before || messages.length < FANSLY_PAGE_LIMIT) {
        // A short/empty page means we exhausted the conversation's history.
        reachedEnd = true;
        break;
      }

      await delay(FANSLY_PAGINATION_DELAY_MS, signal);
    }

    return {
      pages,
      pagesLoaded: currentPage,
      targetPages,
      reachedEnd,
    };
  }
}
