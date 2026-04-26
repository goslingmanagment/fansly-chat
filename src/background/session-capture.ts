import type { RouteKey } from '../shared/types.js';
import { SessionStore, type SessionCaptureResult } from './session-store.js';

function decodeLegacyAccountKey(authorization: string): string | null {
  try {
    const decoded = atob(authorization);
    const accountId = decoded.split(':')[0]?.trim();
    return accountId || null;
  } catch {
    return null;
  }
}

export function normalizeRouteKey(url: string): RouteKey | null {
  if (url.includes('/api/v1/account/wallets/earnings/')) {
    return 'earnings';
  }
  if (url.includes('/api/v1/subscribers')) {
    return 'subscribers';
  }
  if (url.includes('/api/v1/media/orderhistory')) {
    return 'media';
  }
  if (url.includes('/api/v1/messaging/groups')) {
    return 'messagingGroups';
  }
  if (url.includes('/api/v1/group/')) {
    return 'group';
  }
  if (url.includes('/api/v1/message')) {
    return 'message';
  }
  if (url.includes('/api/v1/account?')) {
    return 'account';
  }
  return null;
}

function extractCapture(
  headers: browser.webRequest.HttpHeaders | undefined,
  url: string,
): SessionCaptureResult | null {
  if (!headers) {
    return null;
  }

  const normalized = new Map<string, string>();
  for (const header of headers) {
    if (!header.name || header.value === undefined) {
      continue;
    }
    normalized.set(header.name.toLowerCase(), header.value);
  }

  const authorization = normalized.get('authorization');
  const fanslyClientId = normalized.get('fansly-client-id');
  const fanslyClientTs = normalized.get('fansly-client-ts');
  const fanslySessionId = normalized.get('fansly-session-id');

  // All 4 headers are mandatory
  if (!authorization || !fanslyClientId || !fanslyClientTs || !fanslySessionId) {
    return null;
  }

  const accountId = decodeLegacyAccountKey(authorization);
  if (!accountId) {
    return null;
  }

  return {
    accountId,
    authorization,
    fanslyClientId,
    fanslySessionId,
    fanslyClientTs,
    fanslyClientCheck: normalized.get('fansly-client-check') ?? null,
    routeKey: normalizeRouteKey(url),
  };
}

export function initializeSessionCapture(
  sessionStore: SessionStore,
  onCapture: (tabId: number, accountId: string) => void | Promise<void>,
): void {
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      // Ignore non-tab requests (e.g., extension background requests)
      if (details.tabId < 0) {
        return;
      }

      const capture = extractCapture(details.requestHeaders, details.url);
      if (!capture) {
        return;
      }

      sessionStore.registerCapture(details.tabId, capture);
      void onCapture(details.tabId, capture.accountId);
    },
    { urls: ['https://apiv3.fansly.com/*'] },
    ['requestHeaders'],
  );
}
