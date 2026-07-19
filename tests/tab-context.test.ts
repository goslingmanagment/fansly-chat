import { describe, expect, it } from 'vitest';
import { TabContextStore } from '../src/background/tab-context.js';

describe('TabContextStore.setRoute fan hygiene', () => {
  it('clears the cached fan on ANY conversation change, not only a null route', () => {
    // Round-12 P1-2: an SPA transition A→B must not leave A's fan under groupId B —
    // otherwise recap-status(B, null) resolves fanRef=A from the tab context and
    // the Hub can return A's recap metadata for B's conversation.
    const store = new TabContextStore();

    store.setRoute(1, 'group-A', 1);
    store.setFan(1, 'fan-A', 'Alice');
    expect(store.get(1)).toMatchObject({ groupId: 'group-A', fanAccountId: 'fan-A', fanDisplayName: 'Alice' });

    // A→B (both non-null): the fan is dropped.
    store.setRoute(1, 'group-B', 2);
    expect(store.get(1)).toMatchObject({
      groupId: 'group-B',
      fanAccountId: null,
      fanDisplayName: null,
      routeNonce: 2,
    });
  });

  it('keeps the fan when the SAME conversation is re-set (a routeNonce bump)', () => {
    const store = new TabContextStore();
    store.setRoute(1, 'group-A', 1);
    store.setFan(1, 'fan-A', 'Alice');

    // Same groupId, new nonce — same conversation, so the resolved fan survives.
    store.setRoute(1, 'group-A', 2);
    expect(store.get(1)).toMatchObject({ groupId: 'group-A', fanAccountId: 'fan-A', routeNonce: 2 });
  });

  it('still clears the fan on a null route', () => {
    const store = new TabContextStore();
    store.setRoute(1, 'group-A', 1);
    store.setFan(1, 'fan-A', 'Alice');
    store.setRoute(1, null, 2);
    expect(store.get(1)).toMatchObject({ groupId: null, fanAccountId: null, fanDisplayName: null });
  });
});
