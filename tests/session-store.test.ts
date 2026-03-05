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
