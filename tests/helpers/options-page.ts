import { vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { STORAGE_SCHEMA_VERSION } from '../../src/shared/constants.js';
import {
  createDefaultSettings,
  migrateState,
  serializePersistedState,
} from '../../src/shared/migrations.js';
import type {
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AiQuotaStatus,
  PersistedState,
  SessionSnapshotEntry,
  Settings,
  SpendersObservation,
} from '../../src/shared/types.js';

export interface MountOverrides {
  /** Merged over the default Settings. */
  settings?: Partial<Settings>;
  /** Merged over the default PersistedState (settings + schemaVersion fixed). */
  state?: Partial<Omit<PersistedState, 'settings' | 'schemaVersion'>>;
  /** Reply for the getSessionsSnapshot runtime request (defaults to []). */
  sessions?: SessionSnapshotEntry[];
  /** Deterministic replies for the P2 status/hero runtime reads. Each field may
   * be a value OR a factory — a factory lets a test return a deferred promise
   * (signature-guard A→B race) or a rejecting promise (independent-source
   * failure), so one source can fail without stranding the other. */
  runtime?: {
    health?: AgencyHubHealthResponse | (() => AgencyHubHealthResponse | Promise<AgencyHubHealthResponse>);
    identity?: AgencyHubIdentityResponse | (() => AgencyHubIdentityResponse | Promise<AgencyHubIdentityResponse>);
    quotaByPage?: Record<string, AiQuotaStatus> | (() => Record<string, AiQuotaStatus> | Promise<Record<string, AiQuotaStatus>>);
    spenders?: SpendersObservation | null | (() => SpendersObservation | null | Promise<SpendersObservation | null>);
  };
}

export interface MountedOptionsPage {
  document: Document;
  window: Window & typeof globalThis;
  /** Drain microtasks and any pending timers so render() settles. */
  flushAsync: () => Promise<void>;
  /** The in-memory storage record, normalized the way the app reads it. */
  getState: () => PersistedState;
}

let dom: InstanceType<typeof JSDOM> | null = null;

/**
 * Mount the real options page (`src/options/index.ts`) against a fresh JSDOM
 * and an in-memory storage record for NEW P1 shell tests. This is deliberately
 * slim: the existing options suites keep their own rich harnesses (stall/fail
 * gates, storage-change emission, reassignable state). This helper only stages
 * enough for a test to mount the page, let it settle, and read back what was
 * persisted.
 */
export async function mountOptionsPage(
  overrides: MountOverrides = {},
): Promise<MountedOptionsPage> {
  const settings: Settings = {
    ...createDefaultSettings(),
    ...overrides.settings,
  };
  const state: PersistedState = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings,
    personalities: [],
    personaCatalog: [],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides.state,
  };

  const sessions = overrides.sessions ?? [];
  const runtime = overrides.runtime ?? {};

  // v14 storage.local layout: credentials live in their own custody keys and
  // the `settings` blob is stripped of them. serializePersistedState is the
  // app's own writer, so the record the mocked storage hands back matches
  // production exactly; migrateState reconstructs it the way the page reads it.
  let stored: Record<string, unknown> = serializePersistedState(state);

  dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatgoose-options-root"></div></body></html>',
    { url: 'https://localhost/options.html' },
  );
  const { window } = dom;

  // theme.ts reads window.matchMedia (guarded, but a real browser always
  // provides it). Give the harness a benign light-mode result.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);

  vi.stubGlobal('browser', {
    storage: {
      local: {
        // get(null) or get(key): the app reads the whole record and slices it
        // itself, so returning a clone of everything is sufficient and safe.
        get: vi.fn(async () => structuredClone(stored)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          stored = { ...stored, ...items };
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete stored[key];
          }
        }),
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.0.0-test' })),
      sendMessage: vi.fn(async (message: unknown) => {
        const requestType =
          message && typeof message === 'object'
            ? (message as { type?: unknown }).type
            : undefined;
        // Resolve a value-or-factory override; an omitted override yields the
        // honest fallback. `await` surfaces a factory's rejection to the caller
        // so the page's Promise.allSettled sees it as an independent failure.
        const runtimeReply = async <T>(
          override: T | (() => T | Promise<T>) | undefined,
          fallback: T,
        ): Promise<T> => {
          if (override === undefined) return fallback;
          return typeof override === 'function'
            ? await (override as () => T | Promise<T>)()
            : override;
        };
        switch (requestType) {
          case 'getSessionsSnapshot':
            return sessions;
          case 'getAgencyHubHealth':
            return runtimeReply<AgencyHubHealthResponse>(runtime.health, { ok: false, reason: 'no_base_url' });
          case 'getAgencyHubIdentity':
            return runtimeReply<AgencyHubIdentityResponse>(runtime.identity, { ok: false, reason: 'no_credential' });
          case 'getAiQuotaByPage':
            return runtimeReply<Record<string, AiQuotaStatus>>(runtime.quotaByPage, {});
          case 'getSpendersStatus':
            return runtimeReply<SpendersObservation | null>(runtime.spenders, null);
          default:
            return undefined;
        }
      }),
      openOptionsPage: vi.fn(async () => undefined),
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    },
  });

  vi.resetModules();
  await import('../../src/options/index.js');

  const flushAsync = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    await vi.runOnlyPendingTimersAsync().catch(() => undefined);
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  };
  await flushAsync();

  return {
    document: window.document as unknown as Document,
    window: window as unknown as Window & typeof globalThis,
    flushAsync,
    getState: () => migrateState(structuredClone(stored)),
  };
}

export async function unmountOptionsPage(): Promise<void> {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dom?.window.close();
  dom = null;
}
