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
});
