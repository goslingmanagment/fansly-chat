import { describe, expect, it } from 'vitest';
import { SessionStore, type SessionCaptureResult } from '../src/background/session-store.js';

function makeCapture(accountId: string): SessionCaptureResult {
  return {
    accountId,
    authorization: `Bearer ${accountId}`,
    fanslyClientId: `${accountId}-client`,
    fanslySessionId: `${accountId}-session`,
    fanslyClientTs: `${Date.now()}`,
    fanslyClientCheck: `${accountId}-check`,
    routeKey: 'group',
  };
}

describe('SessionStore', () => {
  it('refreshes credentials in place so an in-flight reference sees the re-login', () => {
    const store = new SessionStore();

    const inFlight = store.registerCapture(1, {
      ...makeCapture('account-1'),
      authorization: 'Bearer stale',
    });
    expect(inFlight.connected).toBe(true);

    // The token expired mid-request, then the same account re-logged in.
    store.markDisconnected('account-1');
    expect(inFlight.connected).toBe(false);

    store.registerCapture(1, { ...makeCapture('account-1'), authorization: 'Bearer fresh' });

    // The reference the in-flight request still holds reflects both updates.
    expect(inFlight.authorization).toBe('Bearer fresh');
    expect(inFlight.connected).toBe(true);
    expect(store.getSessionByAccount('account-1')).toBe(inFlight);
  });

  it('drops an orphaned session when a tab is recaptured onto a different account', () => {
    const store = new SessionStore();

    store.registerCapture(1, makeCapture('account-1'));
    store.registerCapture(1, makeCapture('account-2'));

    expect(store.getSessionByAccount('account-1')).toBeNull();
    expect(store.getSessionByAccount('account-2')).not.toBeNull();
    expect(store.snapshot().map((session) => session.legacyAccountId)).toEqual(['account-2']);
  });

  it('preserves the old session when another tab still references it', () => {
    const store = new SessionStore();

    store.registerCapture(1, makeCapture('account-1'));
    store.registerCapture(2, makeCapture('account-1'));
    store.registerCapture(1, makeCapture('account-2'));

    expect(store.getSessionByAccount('account-1')).not.toBeNull();
    expect(
      store.snapshot().map((session) => session.legacyAccountId).sort(),
    ).toEqual(['account-1', 'account-2']);
  });

  it('removes the final session when forgetting the last tab reference', () => {
    const store = new SessionStore();

    store.registerCapture(1, makeCapture('account-1'));
    store.forgetTab(1);

    expect(store.getSessionByAccount('account-1')).toBeNull();
    expect(store.snapshot()).toEqual([]);
  });

  it('returns snapshot entries only for active-tab-backed sessions', () => {
    const store = new SessionStore();

    store.registerCapture(1, makeCapture('account-1'));
    store.registerCapture(2, makeCapture('account-1'));
    store.registerCapture(3, makeCapture('account-2'));
    store.forgetTab(3);

    const snapshot = store.snapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.legacyAccountId).toBe('account-1');
  });
});
