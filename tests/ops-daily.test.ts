import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'chatgoose:opsDaily';

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
} {
  const record: Record<string, unknown> = {};
  let pendingStall: Deferred<void> | null = null;
  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (
          Object.prototype.hasOwnProperty.call(record, key)
            ? { [key]: structuredClone(record[key]) }
            : {}
        )),
        set: vi.fn(async (items: Record<string, unknown>) => {
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
  };
}

async function loadModule(): Promise<typeof import('../src/background/ops-daily.js')> {
  vi.resetModules();
  return import('../src/background/ops-daily.js');
}

describe('ops-daily tracker', () => {
  let storage: ReturnType<typeof installStorage>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T10:00:00.000Z'));
    storage = installStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('starts as an honest empty day', async () => {
    const { getOpsDaily } = await loadModule();
    expect(await getOpsDaily()).toEqual({
      version: 1,
      dateUtc: '2026-07-24',
      hubErrors: [],
      hubErrorsTotal: 0,
      lastGeneration: null,
      pageByAccount: {},
      lastSummaryPush: null,
    });
  });

  it('counts only CG-HUB- codes', async () => {
    const { getOpsDaily, recordHubError } = await loadModule();
    await recordHubError('CG-HUB-04');
    await recordHubError('CG-FAN-01');
    await recordHubError('CG-FLOW-02');
    await recordHubError('CG-HUB-07');

    const snapshot = await getOpsDaily();
    expect(snapshot.hubErrorsTotal).toBe(2);
    expect(snapshot.hubErrors.map((entry) => entry.code)).toEqual([
      'CG-HUB-04',
      'CG-HUB-07',
    ]);
  });

  it('caps the error list at 20 while the total stays exact', async () => {
    const { getOpsDaily, recordHubError } = await loadModule();
    for (let index = 0; index < 25; index += 1) {
      await recordHubError(`CG-HUB-${String(index).padStart(2, '0')}`);
    }

    const snapshot = await getOpsDaily();
    expect(snapshot.hubErrorsTotal).toBe(25);
    expect(snapshot.hubErrors).toHaveLength(20);
    // The tail is kept — the newest failures are the useful ones.
    expect(snapshot.hubErrors[0]?.code).toBe('CG-HUB-05');
    expect(snapshot.hubErrors[19]?.code).toBe('CG-HUB-24');
  });

  it('records an accepted generation and the account→page binding', async () => {
    const { getOpsDaily, recordGeneration } = await loadModule();
    await recordGeneration({
      feature: 'fast-reply',
      accountId: 'acc-1',
      accountLabel: 'lora',
      pageLabel: 'lora-1',
    });

    const snapshot = await getOpsDaily();
    expect(snapshot.lastGeneration).toEqual({
      at: Date.parse('2026-07-24T10:00:00.000Z'),
      feature: 'fast-reply',
      accountId: 'acc-1',
      accountLabel: 'lora',
      pageLabel: 'lora-1',
    });
    expect(snapshot.pageByAccount).toEqual({ 'acc-1': 'lora-1' });
  });

  it('records the last Fan Summary push', async () => {
    const { getOpsDaily, recordSummaryPush } = await loadModule();
    await recordSummaryPush('lora');
    expect(await getOpsDaily()).toMatchObject({
      lastSummaryPush: { at: Date.parse('2026-07-24T10:00:00.000Z'), accountLabel: 'lora' },
    });
  });

  it('resets on the UTC day boundary the kernel quota resets at', async () => {
    const { getOpsDaily, recordGeneration, recordHubError } = await loadModule();
    await recordHubError('CG-HUB-04');
    await recordGeneration({
      feature: 'ping',
      accountId: 'acc-1',
      accountLabel: 'lora',
      pageLabel: 'lora-1',
    });

    // 23:59 UTC: still the same day.
    vi.setSystemTime(new Date('2026-07-24T23:59:00.000Z'));
    expect((await getOpsDaily()).hubErrorsTotal).toBe(1);

    // 00:01 the next UTC day: yesterday's counters would lie.
    vi.setSystemTime(new Date('2026-07-25T00:01:00.000Z'));
    const fresh = await getOpsDaily();
    expect(fresh.dateUtc).toBe('2026-07-25');
    expect(fresh.hubErrorsTotal).toBe(0);
    expect(fresh.hubErrors).toEqual([]);
    expect(fresh.lastGeneration).toBeNull();
    expect(fresh.pageByAccount).toEqual({});

    // …and a write on the new day starts from the fresh record.
    await recordHubError('CG-HUB-07');
    expect((await getOpsDaily()).hubErrorsTotal).toBe(1);
  });

  it('serializes concurrent mutations so neither is lost', async () => {
    const { getOpsDaily, recordHubError, recordSummaryPush } = await loadModule();
    // Hold the FIRST write open: without the FIFO queue the second recorder
    // would read the pre-write record and clobber the first one's counter.
    const stall = storage.stallNextSet();
    const first = recordHubError('CG-HUB-04');
    const second = recordSummaryPush('lora');

    stall.resolve();
    await Promise.all([first, second]);

    const snapshot = await getOpsDaily();
    expect(snapshot.hubErrorsTotal).toBe(1);
    expect(snapshot.lastSummaryPush?.accountLabel).toBe('lora');
  });

  it('discards a foreign-version record rather than half-trusting it', async () => {
    storage.record[STORAGE_KEY] = {
      version: 2,
      dateUtc: '2026-07-24',
      hubErrorsTotal: 99,
    };
    const { getOpsDaily } = await loadModule();
    const snapshot = await getOpsDaily();
    expect(snapshot.version).toBe(1);
    expect(snapshot.hubErrorsTotal).toBe(0);
  });

  it('persists under its own operational key, never the settings blob', async () => {
    const { recordHubError } = await loadModule();
    await recordHubError('CG-HUB-04');
    expect(Object.keys(storage.record)).toEqual([STORAGE_KEY]);
    expect(storage.record.settings).toBeUndefined();
  });
});
