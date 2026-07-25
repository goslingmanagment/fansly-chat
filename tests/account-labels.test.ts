import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLabelsSnapshot } from '../src/shared/types.js';

const STORAGE_KEY = 'chatgoose:accountLabels';

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

function installStorage(): {
  record: Record<string, unknown>;
  stallNextSet: () => Deferred<void>;
  failNextSet: () => void;
  setCalls: () => number;
} {
  const record: Record<string, unknown> = {};
  let pendingStall: Deferred<void> | null = null;
  let pendingFailure = false;
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
          if (pendingFailure) {
            pendingFailure = false;
            throw new Error('quota exceeded');
          }
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
    failNextSet: () => {
      pendingFailure = true;
    },
    setCalls: () => setCalls,
  };
}

async function loadModule(): Promise<typeof import('../src/background/account-labels.js')> {
  vi.resetModules();
  return import('../src/background/account-labels.js');
}

describe('account labels store', () => {
  let storage: ReturnType<typeof installStorage>;

  beforeEach(() => {
    storage = installStorage();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('stores a trimmed label and clears it when emptied', async () => {
    const { getAccountLabels, setAccountLabel } = await loadModule();
    expect(await getAccountLabels()).toEqual({ version: 1, byAccount: {} });

    await setAccountLabel('acc-1', '  Лора · утро  ');
    expect(await getAccountLabels()).toEqual({
      version: 1,
      byAccount: { 'acc-1': 'Лора · утро' },
    });

    // An emptied field means «remove the label», never a stored empty string.
    await setAccountLabel('acc-1', '   ');
    expect(await getAccountLabels()).toEqual({ version: 1, byAccount: {} });
  });

  it('collapses whitespace and caps the length so a paste cannot blow out a row', async () => {
    const { getAccountLabels, normalizeLabel, setAccountLabel } = await loadModule();
    expect(normalizeLabel('a\n\nb   c')).toBe('a b c');

    await setAccountLabel('acc-1', 'x'.repeat(200));
    expect((await getAccountLabels()).byAccount['acc-1']).toHaveLength(60);
  });

  it('serializes overlapping renames so neither label is clobbered (FIFO)', async () => {
    const { getAccountLabels, setAccountLabel } = await loadModule();
    const stall = storage.stallNextSet();

    const first = setAccountLabel('acc-1', 'one');
    const second = setAccountLabel('acc-2', 'two');
    stall.resolve();
    await Promise.all([first, second]);

    // storage.local.set replaces the WHOLE record — without the queue the second
    // read-modify-write would have erased acc-1.
    expect((await getAccountLabels()).byAccount).toEqual({
      'acc-1': 'one',
      'acc-2': 'two',
    });
  });

  it('writes only when the mutation actually changed the record', async () => {
    const { setAccountLabel, transferAccountLabel } = await loadModule();

    // Clearing a label that was never set removes nothing, and
    // storage.local.set replaces the WHOLE record — writing here is pure churn.
    await setAccountLabel('ghost', '');
    expect(storage.setCalls()).toBe(0);

    // `rekeyAccountIdentity` calls the transfer on EVERY getSessionsSnapshot
    // while a legacy-id session is open (an options mount plus a ≥5s
    // focus/visibility repoll), long after the one real transfer.
    await transferAccountLabel('legacy', 'canonical');
    expect(storage.setCalls()).toBe(0);

    await setAccountLabel('acc-1', 'Лора');
    expect(storage.setCalls()).toBe(1);
    // Re-saving the same text (a blur after no edit) is not a change.
    await setAccountLabel('acc-1', '  Лора  ');
    expect(storage.setCalls()).toBe(1);
    expect(storage.record[STORAGE_KEY]).toEqual({
      version: 1,
      byAccount: { 'acc-1': 'Лора' },
    } satisfies AccountLabelsSnapshot);
  });

  it('rejects a failed write so the pane can say the rename did not stick', async () => {
    const { getAccountLabels, setAccountLabel } = await loadModule();
    storage.failNextSet();

    // Unlike presence (best-effort telemetry) this is a deliberate chatter
    // action: swallowing the failure would silently revert on reload.
    await expect(setAccountLabel('acc-1', 'Лора')).rejects.toThrow();
    expect((await getAccountLabels()).byAccount['acc-1']).toBeUndefined();

    // The queue stays usable after the failure.
    await setAccountLabel('acc-1', 'Лора');
    expect((await getAccountLabels()).byAccount['acc-1']).toBe('Лора');
  });

  it('discards a foreign-version or malformed record instead of half-trusting it', async () => {
    const { getAccountLabels } = await loadModule();
    storage.record[STORAGE_KEY] = { version: 7, byAccount: { 'acc-1': 'x' } };
    expect(await getAccountLabels()).toEqual({ version: 1, byAccount: {} });

    storage.record[STORAGE_KEY] = { version: 1, byAccount: { good: 'Лора', bad: 42 } };
    expect(await getAccountLabels()).toEqual({
      version: 1,
      byAccount: { good: 'Лора' },
    });
  });

  it('transfers a legacy label onto the canonical id — canonical wins, legacy removed', async () => {
    const { getAccountLabels, transferAccountLabel } = await loadModule();
    storage.record[STORAGE_KEY] = {
      version: 1,
      byAccount: { legacy: 'старая', canonical: 'канон' },
    } satisfies AccountLabelsSnapshot;

    await transferAccountLabel('legacy', 'canonical');

    expect((await getAccountLabels()).byAccount).toEqual({ canonical: 'канон' });
  });

  it('moves the label wholesale when the canonical id has none yet', async () => {
    const { getAccountLabels, transferAccountLabel } = await loadModule();
    storage.record[STORAGE_KEY] = {
      version: 1,
      byAccount: { legacy: 'Лора' },
    } satisfies AccountLabelsSnapshot;

    await transferAccountLabel('legacy', 'canonical');

    expect((await getAccountLabels()).byAccount).toEqual({ canonical: 'Лора' });
  });
});
