import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { PersistedState } from '../src/shared/types.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeState(): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [
      {
        id: 'custom-1',
        name: 'Custom',
        content: 'Be helpful',
        updatedAt: 1,
      },
    ],
    personaCatalog: [
      { key: 'custom-1', displayName: 'Custom', definitionId: 'v1:custom-one-definition', version: 1, status: 'active' },
      { key: 'builtin:lora', displayName: 'Lora', definitionId: 'v1:built-in-lora-definition', version: 2, status: 'active' },
    ],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: ['account-a', 'account-b'],
  };
}

describe('MappingBanner', () => {
  let dom: InstanceType<typeof JSDOM>;
  let storageGet: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;
  let backingStorage: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);

    backingStorage = makeState() as unknown as Record<string, unknown>;
    const readBacking = async (keys?: string | null): Promise<Record<string, unknown>> => {
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(backingStorage, keys)
          ? { [keys]: structuredClone(backingStorage[keys]) }
          : {};
      }
      return structuredClone(backingStorage);
    };
    storageGet = vi.fn(readBacking);
    storageSet = vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(backingStorage, structuredClone(items));
    });
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
          remove: vi.fn(async () => undefined),
        },
      },
      runtime: {
        getManifest: vi.fn(() => ({ version: 'test' })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    dom.window.close();
  });

  it('does not let an older async render reopen a hidden banner', async () => {
    const read = deferred<Record<string, unknown>>();
    storageGet.mockReturnValueOnce(read.promise);
    const { MappingBanner } = await import('../src/content/mapping-banner.js');
    const banner = new MappingBanner({ onOpenSettings: vi.fn() });

    const staleRender = banner.render('account-a', false);
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalledTimes(1));
    await banner.render('account-b', true);
    read.resolve(makeState() as unknown as Record<string, unknown>);
    await staleRender;

    expect(banner.root.classList.contains('chatgoose-hidden')).toBe(true);
    expect(banner.root.querySelector('.chatgoose-banner-actions')?.childElementCount).toBe(0);
  });

  it('does not let stale account controls save after a newer account wins', async () => {
    const nextRead = deferred<Record<string, unknown>>();
    await ensureSnapshotReady();
    const { MappingBanner } = await import('../src/content/mapping-banner.js');
    const banner = new MappingBanner({ onOpenSettings: vi.fn() });

    await banner.render('account-a', false);
    storageSet.mockClear();
    const staleSelect = banner.root.querySelector<HTMLSelectElement>('select')!;
    const staleSave = banner.root.querySelector<HTMLButtonElement>('.chatgoose-button')!;

    // ensureLegacyPersonaSnapshot first re-reads the immutable snapshot key;
    // delay the following raw state read that belongs to this render.
    storageGet
      .mockResolvedValueOnce({ legacyPersonaSnapshotV1: backingStorage.legacyPersonaSnapshotV1 })
      .mockReturnValueOnce(nextRead.promise);
    const currentRender = banner.render('account-b', false);
    staleSelect.value = 'custom-1';
    staleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    staleSave.click();
    await Promise.resolve();

    expect(storageSet).not.toHaveBeenCalled();
    nextRead.resolve(backingStorage);
    await currentRender;
    expect(banner.root.textContent).toContain('account-b');
  });

  it('does not offer an archived server persona as a valid mapping', async () => {
    const state = makeState();
    state.personaCatalog[0] = {
      key: 'custom-1',
      displayName: 'Archived custom',
      definitionId: 'v1:custom-one-archived',
      version: 2,
      status: 'archived',
    };
    storageGet.mockResolvedValue(state);
    const { MappingBanner } = await import('../src/content/mapping-banner.js');
    const banner = new MappingBanner({ onOpenSettings: vi.fn() });

    await banner.render('account-a', false);

    const option = Array.from(banner.root.querySelectorAll('option'))
      .find((candidate) => candidate.value === 'custom-1');
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toContain('archived');
  });
});

async function ensureSnapshotReady(): Promise<void> {
  const { ensureLegacyPersonaSnapshot } = await import('../src/shared/persona-preservation.js');
  await ensureLegacyPersonaSnapshot();
}
