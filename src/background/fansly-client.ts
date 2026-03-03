import {
  FANSLY_PAGINATION_DELAY_MS,
  FANSLY_REQUEST_TIMEOUT_MS,
  FANSLY_RETRY_DELAYS_MS,
} from '../shared/constants.js';
import { aggregateEarnings } from '../shared/earnings.js';
import { ChatMuseError } from '../shared/errors.js';
import {
  buildTranscriptWindowStart,
  estimateTargetPages,
  extractOldestMessageId,
  normalizeTranscript,
} from '../shared/transcript.js';
import type {
  AggregatedEarnings,
  EarningsRow,
  FanslyAccountResponse,
  FanslyMessagingGroupsResponse,
  FanslyMessagePageResponse,
  FanslySubscriberSubscriptionRecord,
  FanslySubscribersResponse,
  FanSubscriptionContext,
  FanSubscriptionSource,
  NormalizedTranscriptMessage,
  RouteKey,
  SessionTemplate,
  SubscriptionLookupMode,
} from '../shared/types.js';
import { SessionStore } from './session-store.js';

const MESSAGING_GROUPS_PAGE_SIZE = 100;
const SUBSCRIBERS_PAGE_SIZE = 100;
const SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1000;

function withNgswBypass(url: URL): URL {
  url.searchParams.set('ngsw-bypass', 'true');
  return url;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
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
  transcriptMessages: NormalizedTranscriptMessage[];
  windowStartMs: number;
  pagesLoaded: number;
  targetPages: number;
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

  private async fetchEnvelope<T>(
    url: URL,
    session: SessionTemplate,
    routeKey: RouteKey,
    signal: AbortSignal,
    optional = false,
    attempt = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), FANSLY_REQUEST_TIMEOUT_MS);
    const composite = AbortSignal.any([signal, controller.signal]);
    const requestTs = String(Date.now());

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

      const response = await fetch(withNgswBypass(url), {
        method: 'GET',
        headers,
        signal: composite,
        credentials: 'omit',
      });

      if (response.status === 401 || response.status === 403) {
        this.sessionStore.markDisconnected(session.accountId);
        throw new ChatMuseError('session_expired', undefined, { status: response.status });
      }

      if ((response.status === 429 || response.status >= 500) && attempt < FANSLY_RETRY_DELAYS_MS.length) {
        await delay(FANSLY_RETRY_DELAYS_MS[attempt]!, signal);
        return this.fetchEnvelope<T>(url, session, routeKey, signal, optional, attempt + 1);
      }

      if (!response.ok) {
        const snippet = await readResponseSnippet(response);
        throw new ChatMuseError(optional ? 'unknown_error' : 'fansly_server_error', undefined, {
          status: response.status,
          responseSnippet: snippet,
        });
      }

      const data = (await response.json()) as { success: boolean; response?: T; error?: string };
      if (!data.success || data.response === undefined) {
        throw new ChatMuseError(optional ? 'unknown_error' : 'fansly_server_error');
      }

      return data.response;
    } catch (error) {
      if (error instanceof ChatMuseError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new ChatMuseError(optional ? 'unknown_error' : 'network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  async getGroup(
    groupId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<{ users?: Array<{ userId: string }> }> {
    return this.fetchEnvelope<{ users?: Array<{ userId: string }> }>(
      new URL(`https://apiv3.fansly.com/api/v1/group/${groupId}/`),
      session,
      'group',
      signal,
      true,
    );
  }

  async getAuthenticatedAccountId(session: SessionTemplate, signal: AbortSignal): Promise<string> {
    const account = await this.getAuthenticatedAccount(session, signal);
    return account.id;
  }

  async getAuthenticatedAccount(
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanslyAccountResponse> {
    if (
      session.resolvedAccountId &&
      (session.resolvedUsername !== null || session.resolvedDisplayName !== null)
    ) {
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
    );
    const accountId = response.account?.id?.trim();

    if (!accountId) {
      throw new ChatMuseError('unknown_error');
    }

    session.resolvedAccountId = accountId;
    session.resolvedUsername = response.account?.username?.trim() || null;
    session.resolvedDisplayName = response.account?.displayName?.trim() || null;

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
  ): Promise<FanslyMessagePageResponse> {
    const url = new URL('https://apiv3.fansly.com/api/v1/message');
    url.searchParams.set('groupId', groupId);
    url.searchParams.set('limit', '25');
    if (before) {
      url.searchParams.set('before', before);
    }
    return this.fetchEnvelope<FanslyMessagePageResponse>(url, session, 'message', signal);
  }

  async getAccountNames(
    ids: string[],
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanslyAccountResponse[]> {
    const url = new URL('https://apiv3.fansly.com/api/v1/account');
    url.searchParams.set('ids', ids.join(','));
    const response = await this.fetchEnvelope<unknown>(url, session, 'account', signal, true);

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
    const rows = await this.fetchEnvelope<EarningsRow[]>(url, session, 'earnings', signal, true);
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return aggregateEarnings(rows, fanAccountId, windowStartMs, windowEndMs);
  }

  private async getActiveConversationSubscriptionFromMessagingGroups(
    groupId: string,
    fanAccountId: string,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<FanSubscriptionContext | null> {
    let offset = 0;

    while (true) {
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
      if (error instanceof ChatMuseError && error.code === 'session_expired') {
        throw error;
      }
      onTrace?.({
        type: 'groups-error',
        code: error instanceof ChatMuseError ? error.code : 'unknown_error',
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
    modelAccountId: string,
    signal: AbortSignal,
    onProgress?: (progress: MessageLoadProgress) => void,
  ): Promise<MessageLoadResult> {
    const targetPages = estimateTargetPages(requestedCount);
    const pages: FanslyMessagePageResponse[] = [];
    let collectedCount = 0;
    let before: string | null = null;
    let currentPage = 0;

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
      if (!before || messages.length < 25) {
        break;
      }

      await delay(FANSLY_PAGINATION_DELAY_MS, signal);
    }

    const transcriptMessages = normalizeTranscript(pages, modelAccountId);
    return {
      transcriptMessages,
      windowStartMs: buildTranscriptWindowStart(transcriptMessages, Date.now()),
      pagesLoaded: currentPage,
      targetPages,
    };
  }
}
