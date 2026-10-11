import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeSessionCapture,
  normalizeRouteKey,
} from '../src/background/session-capture.js';
import { SessionStore } from '../src/background/session-store.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeRouteKey', () => {
  it('maps stats earnings URL to earnings', () => {
    expect(
      normalizeRouteKey(
        'https://apiv3.fansly.com/api/v1/account/wallets/earnings/stats/accounts?correlationAccountId=123',
      ),
    ).toBe('earnings');
  });

  it('maps monthlystats earnings URL to earnings', () => {
    expect(
      normalizeRouteKey(
        'https://apiv3.fansly.com/api/v1/account/wallets/earnings/monthlystats/accounts?correlationAccountId=123',
      ),
    ).toBe('earnings');
  });

  it('maps subscribers URL to subscribers', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/subscribers?ids=abc'),
    ).toBe('subscribers');
  });

  it('maps media orderhistory URL to media', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/media/orderhistory?accountMediaId=abc'),
    ).toBe('media');
  });

  it('maps messaging groups URL to messagingGroups', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/messaging/groups?groupId=g1'),
    ).toBe('messagingGroups');
  });

  it('maps group URL to group', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/group/g1'),
    ).toBe('group');
  });

  it('maps message URL to message', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/message?groupId=g1'),
    ).toBe('message');
  });

  it('maps account URL to account', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/account?ids=abc'),
    ).toBe('account');
  });

  it('returns null for unknown URL', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/something/else'),
    ).toBeNull();
  });
});

describe('initializeSessionCapture', () => {
  it('refreshes the request template on every request but notifies only on material session changes', () => {
    interface CaptureDetails {
      tabId: number;
      url: string;
      requestHeaders: browser.webRequest.HttpHeaders;
    }
    let listener: ((details: CaptureDetails) => void) | null = null;
    vi.stubGlobal('browser', {
      runtime: { getURL: (path: string) => `moz-extension://chatgoose-test/${path}` },
      webRequest: {
        onBeforeSendHeaders: {
          addListener: vi.fn((nextListener: typeof listener) => {
            listener = nextListener;
          }),
        },
      },
    });

    const store = new SessionStore();
    const onCapture = vi.fn();
    initializeSessionCapture(store, onCapture);

    const emit = (
      accountId: string,
      options?: { sessionId?: string; ts?: string; check?: string },
    ) => {
      if (!listener) throw new Error('Capture listener was not registered');
      listener({
        tabId: 7,
        url: 'https://apiv3.fansly.com/api/v1/message?groupId=g1',
        requestHeaders: [
          { name: 'authorization', value: btoa(`${accountId}:secret`) },
          { name: 'fansly-client-id', value: 'client-1' },
          { name: 'fansly-session-id', value: options?.sessionId ?? 'session-1' },
          { name: 'fansly-client-ts', value: options?.ts ?? '100' },
          { name: 'fansly-client-check', value: options?.check ?? 'check-1' },
        ],
      });
    };

    emit('account-1');
    for (let request = 0; request < 20; request += 1) {
      emit('account-1', {
        ts: String(101 + request),
        check: `check-${request + 2}`,
      });
    }

    expect(onCapture).toHaveBeenCalledTimes(21);
    expect(onCapture.mock.calls.filter((call) => call[2] === true)).toHaveLength(1);
    expect(onCapture).toHaveBeenLastCalledWith(7, 'account-1', false);
    expect(store.getSessionForTab(7)).toMatchObject({
      latestTs: '120',
      latestCheck: 'check-21',
    });

    emit('account-1', { sessionId: 'session-2', ts: '121' });
    expect(onCapture.mock.calls.filter((call) => call[2] === true)).toHaveLength(2);

    store.markDisconnected('account-1');
    emit('account-1', { sessionId: 'session-2', ts: '122' });
    expect(onCapture.mock.calls.filter((call) => call[2] === true)).toHaveLength(3);

    emit('account-2', { sessionId: 'session-3', ts: '123' });
    expect(onCapture.mock.calls.filter((call) => call[2] === true)).toHaveLength(4);
    expect(onCapture).toHaveBeenLastCalledWith(7, 'account-2', true);
  });

  it('E149: never captures the relay frame\'s own requests as the page\'s session', () => {
    interface FrameDetails {
      tabId: number;
      frameId?: number;
      url: string;
      documentUrl?: string;
      originUrl?: string;
      requestHeaders: browser.webRequest.HttpHeaders;
    }
    let listener: ((details: FrameDetails) => void) | null = null;
    vi.stubGlobal('browser', {
      runtime: { getURL: (path: string) => `moz-extension://chatgoose-test/${path}` },
      webRequest: {
        onBeforeSendHeaders: {
          addListener: vi.fn((nextListener: typeof listener) => {
            listener = nextListener;
          }),
        },
      },
    });
    const store = new SessionStore();
    const onCapture = vi.fn();
    initializeSessionCapture(store, onCapture);
    const headers = (check: string): browser.webRequest.HttpHeaders => [
      { name: 'authorization', value: btoa('account-1:secret') },
      { name: 'fansly-client-id', value: 'client-1' },
      { name: 'fansly-session-id', value: 'session-1' },
      { name: 'fansly-client-ts', value: '100' },
      { name: 'fansly-client-check', value: check },
    ];
    const url = 'https://apiv3.fansly.com/api/v1/message?groupId=g1';

    // The page's own request is the capture.
    listener!({ tabId: 7, frameId: 0, url, documentUrl: 'https://fansly.com/messages/1', originUrl: 'https://fansly.com/messages/1', requestHeaders: headers('page-check') });
    expect(onCapture).toHaveBeenCalledTimes(1);

    // The relay frame replays that session from the same tab: same tabId,
    // an extension document. It must not overwrite the page's fresh template.
    const frame = 'moz-extension://chatgoose-test/fansly-relay.html';
    listener!({ tabId: 7, frameId: 42, url, documentUrl: frame, originUrl: frame, requestHeaders: headers('replayed-check') });
    listener!({ tabId: 7, frameId: 42, url, originUrl: frame, requestHeaders: headers('replayed-check') });
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(store.getSessionForTab(7)).toMatchObject({ latestCheck: 'page-check', routeChecks: { message: 'page-check' } });

    // Another extension's frame in the tab is not ours and is not special-cased.
    listener!({ tabId: 7, frameId: 43, url, documentUrl: 'moz-extension://someone-else/page.html', requestHeaders: headers('other-check') });
    expect(onCapture).toHaveBeenCalledTimes(2);
  });
});
