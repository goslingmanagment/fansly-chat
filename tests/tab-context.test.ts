import { describe, expect, it } from 'vitest';
import { TabContextStore } from '../src/background/tab-context.js';

describe('TabContextStore route identity', () => {
  it('preserves fan identity for the same group and clears it on a real group change', () => {
    const store = new TabContextStore();
    store.setRoute(7, 'group-1', 1);
    store.setFan(7, 'fan-1', 'Alice');

    store.setRoute(7, 'group-1', 2);
    expect(store.get(7)).toMatchObject({
      groupId: 'group-1',
      routeNonce: 2,
      fanAccountId: 'fan-1',
      fanDisplayName: 'Alice',
    });

    store.setRoute(7, 'group-2', 3);
    expect(store.get(7)).toMatchObject({
      groupId: 'group-2',
      routeNonce: 3,
      fanAccountId: null,
      fanDisplayName: null,
    });
  });
});
