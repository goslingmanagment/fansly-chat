import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountPresenceSnapshot } from '../src/shared/types.js';

const STORAGE_KEY = 'chatgoose:accountPresence';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** In-memory storage.local with a pluggable stall on `set`, so a test can hold
 * one write open and prove the FIFO queue orders the next one behind it. */
function installStorage(): {
  record: Record<string, unknown>;
  stallNextSet: () => Deferred<void>;
  setCalls: () => number;
} {
  const record: Record<string, unknown> = {};
  let pendingStall: Deferred<void> | null = null;
  let setCalls = 0;
  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.prototype.hasOwnProperty.call(record, key)
            ? { [key]: structuredClone(record[key]) }
            : {}
        )),
        set: vi.fn(async (items: Record<string, unknown>) => {
          setCalls += 1;
          if (pendingStall) {
            const stall = pendingStall;
            pendingStall = null;
            await stall.promise;
          }
          Object.assign(record, structuredClone(items));
        }),
      },
    },
  };
  return {
    record,
    stallNextSet: () => {
      pendingStall = createDeferred<void>();
      return pendingStall;
    },
    setCalls: () => setCalls,
  };
}

async function loadModule(): Promise<typeof import('../src/background/account-presence.js')> {
  vi.resetModules();
  return import('../src/background/account-presence.js');
}

function stored(record: Record<string, unknown>): AccountPresenceSnapshot {
  return record[STORAGE_KEY] as AccountPresenceSnapshot;
}

describe('account presence store', () => {
  let storage: ReturnType<typeof installStorage>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T10:00:00.000Z'));
    storage = installStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('starts empty and records a first sighting immediately (leading write)', async () => {
    const { getAccountPresence, recordAccountPresence } = await loadModule();
    expect(await getAccountPresence()).toEqual({ version: 1, byAccount: {} });

    await recordAccountPresence({ accountId: 'acc-1' });

    // A LEADING write, not a trailing debounce: MV3 can suspend the worker before
    // any tail would fire, and a lost sighting is what makes the pane lie.
    expect(storage.setCalls()).toBe(1);
    expect(stored(storage.record)).toEqual({
      version: 1,
      byAccount: {
        'acc-1': {
          lastSeenAt: Date.parse('2026-07-25T10:00:00.000Z'),
          username: null,
          displayName: null,
        },
      },
    });
  });

  it('coalesces a burst of captures into one write for 30s, then writes again', async () => {
    const { getAccountPresence, recordAccountPresence } = await loadModule();

    await recordAccountPresence({ accountId: 'acc-1' });
    // Every Fansly request the tab makes is a capture; these must not each hit
    // storage.
    vi.setSystemTime(new Date('2026-07-25T10:00:05.000Z'));
    await recordAccountPresence({ accountId: 'acc-1' });
    vi.setSystemTime(new Date('2026-07-25T10:00:29.000Z'));
    await recordAccountPresence({ accountId: 'acc-1' });
    expect(storage.setCalls()).toBe(1);
    // The coalesced sighting is at most 30s stale — never invented.
    expect((await getAccountPresence()).byAccount['acc-1']?.lastSeenAt)
      .toBe(Date.parse('2026-07-25T10:00:00.000Z'));

    vi.setSystemTime(new Date('2026-07-25T10:00:31.000Z'));
    await recordAccountPresence({ accountId: 'acc-1' });
    expect(storage.setCalls()).toBe(2);
    expect((await getAccountPresence()).byAccount['acc-1']?.lastSeenAt)
      .toBe(Date.parse('2026-07-25T10:00:31.000Z'));

    // A different account has its own window.
    await recordAccountPresence({ accountId: 'acc-2' });
    expect(storage.setCalls()).toBe(3);
  });

  it('lets an identity upgrade through the coalescing window without erasing names', async () => {
    const { getAccountPresence, recordAccountPresence } = await loadModule();

    // The capture hook fires first, with names still null.
    await recordAccountPresence({ accountId: 'acc-1' });
    vi.setSystemTime(new Date('2026-07-25T10:00:02.000Z'));
    // The fansly-client hook fires two seconds later, INSIDE the window: without
    // the identity-upgrade bypass the pane would show 18 digits forever.
    await recordAccountPresence({
      accountId: 'acc-1',
      username: 'lora',
      displayName: 'Lora',
    });
    expect(storage.setCalls()).toBe(2);
    expect((await getAccountPresence()).byAccount['acc-1']).toEqual({
      lastSeenAt: Date.parse('2026-07-25T10:00:02.000Z'),
      username: 'lora',
      displayName: 'Lora',
    });

    // A later capture (names null again) must NOT wipe the resolved identity.
    vi.setSystemTime(new Date('2026-07-25T10:01:00.000Z'));
    await recordAccountPresence({ accountId: 'acc-1' });
    expect((await getAccountPresence()).byAccount['acc-1']).toEqual({
      lastSeenAt: Date.parse('2026-07-25T10:01:00.000Z'),
      username: 'lora',
      displayName: 'Lora',
    });
  });

  it('serializes overlapping writes so neither account is clobbered (FIFO)', async () => {
    const { getAccountPresence, recordAccountPresence } = await loadModule();
    const stall = storage.stallNextSet();

    const first = recordAccountPresence({ accountId: 'acc-1', username: 'one' });
    const second = recordAccountPresence({ accountId: 'acc-2', username: 'two' });
    stall.resolve();
    await Promise.all([first, second]);

    // storage.local.set replaces the WHOLE record: without the queue the second
    // read-modify-write would have started from a pre-first snapshot and erased
    // acc-1.
    const snapshot = await getAccountPresence();
    expect(Object.keys(snapshot.byAccount).sort()).toEqual(['acc-1', 'acc-2']);
    expect(snapshot.byAccount['acc-1']?.username).toBe('one');
    expect(snapshot.byAccount['acc-2']?.username).toBe('two');
  });

  it('discards a foreign-version or malformed record instead of half-trusting it', async () => {
    const { getAccountPresence } = await loadModule();
    storage.record[STORAGE_KEY] = { version: 2, byAccount: { 'acc-1': { lastSeenAt: 1 } } };
    expect(await getAccountPresence()).toEqual({ version: 1, byAccount: {} });

    storage.record[STORAGE_KEY] = {
      version: 1,
      byAccount: { good: { lastSeenAt: 5, username: 'x', displayName: null }, bad: 'nope' },
    };
    expect(await getAccountPresence()).toEqual({
      version: 1,
      byAccount: { good: { lastSeenAt: 5, username: 'x', displayName: null } },
    });
  });

  it('transfers a legacy record onto the canonical id — canonical wins, legacy removed', async () => {
    const { getAccountPresence, transferAccountPresence } = await loadModule();
    storage.record[STORAGE_KEY] = {
      version: 1,
      byAccount: {
        legacy: { lastSeenAt: 300, username: 'legacy-name', displayName: null },
        canonical: { lastSeenAt: 100, username: 'canonical-name', displayName: null },
      },
    } satisfies AccountPresenceSnapshot;

    await transferAccountPresence('legacy', 'canonical');

    const snapshot = await getAccountPresence();
    expect(Object.keys(snapshot.byAccount)).toEqual(['canonical']);
    expect(snapshot.byAccount.canonical).toEqual({
      // The fresher moment survives; the canonical NAME wins.
      lastSeenAt: 300,
      username: 'canonical-name',
      displayName: null,
    });
  });

  it('moves the record wholesale when the canonical id has none yet', async () => {
    const { getAccountPresence, transferAccountPresence } = await loadModule();
    storage.record[STORAGE_KEY] = {
      version: 1,
      byAccount: { legacy: { lastSeenAt: 42, username: 'lora', displayName: 'Lora' } },
    } satisfies AccountPresenceSnapshot;

    await transferAccountPresence('legacy', 'canonical');

    expect((await getAccountPresence()).byAccount).toEqual({
      canonical: { lastSeenAt: 42, username: 'lora', displayName: 'Lora' },
    });
  });

  it('survives a SessionStore that forgot everything — the whole point of the store', async () => {
    const presence = await loadModule();
    const { SessionStore } = await import('../src/background/session-store.js');

    const store = new SessionStore();
    store.registerCapture(7, {
      accountId: 'acc-live',
      authorization: 'Bearer x',
      fanslyClientId: 'client',
      fanslySessionId: 'session',
      fanslyClientTs: '1',
      fanslyClientCheck: 'check',
      routeKey: 'group',
    });
    // The capture hook is fire-and-forget; let it land.
    await vi.waitFor(async () => {
      expect((await presence.getAccountPresence()).byAccount['acc-live']).toBeTruthy();
    });

    // MV3 suspends the worker: a brand-new SessionStore knows nothing.
    const restarted = new SessionStore();
    expect(restarted.getSessions()).toEqual([]);
    expect(restarted.getTabIdForAccount('acc-live')).toBeNull();
    // The durable record is still there, so the pane can say «была …» instead of
    // «сессий не было».
    expect((await presence.getAccountPresence()).byAccount['acc-live']?.lastSeenAt)
      .toBe(Date.parse('2026-07-25T10:00:00.000Z'));
  });
});
