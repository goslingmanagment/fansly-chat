import { vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  KNOWN_ACCOUNTS_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../../src/shared/constants.js';
import {
  createDefaultSettings,
  migrateState,
  serializePersistedState,
} from '../../src/shared/migrations.js';
import type {
  AccountsView,
  AgencyHubDeviceTokenMeta,
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AgencyHubSignOutResponse,
  AiQuotaStatus,
  OnboardingSnapshot,
  OpsDailySnapshot,
  PersistedState,
  PersonaCatalogEntry,
  SessionSnapshotEntry,
  Settings,
  SpendersObservation,
} from '../../src/shared/types.js';

export interface MountOverrides {
  /** Merged over the default Settings. */
  settings?: Partial<Settings>;
  /** Merged over the default PersistedState (settings + schemaVersion fixed). */
  state?: Partial<Omit<PersistedState, 'settings' | 'schemaVersion'>>;
  /** Reply for the getSessionsSnapshot runtime request (defaults to []). A
   * factory may return a deferred promise so a test can hold the Fansly row
   * unpainted (pre-hydration loading-hero assertion). */
  sessions?: SessionSnapshotEntry[] | (() => SessionSnapshotEntry[] | Promise<SessionSnapshotEntry[]>);
  /** When set, a successful testAgencyHubConnection writes this catalog + source
   * into storage before the mount-tail readStorageState re-reads it — simulating
   * the background catalog refresh that onAgencyHubReady triggers, so a catalog
   * hidden by migrateState at mount becomes visible after the connection test. */
  revealCatalogOnConnect?: { catalog: PersonaCatalogEntry[]; source: string };
  /** Granted host permission for the hub origin (defaults to false — a fresh
   * install). */
  permissionGranted?: boolean;
  /** Location hash the page is mounted with — how an error deep link arrives
   * («#hub:CG-HUB-04»). Defaults to none, i.e. the landing pane. */
  hash?: string;
  /** Extra raw storage.local keys, merged over the serialized state. Operational
   * keys (`chatgoose:*`) live outside PersistedState and are seeded here. */
  storage?: Record<string, unknown>;
  /** The background's «Аккаунты» view. Omitted = the operation is unavailable
   * (the page then degrades to knownAccounts + the sessions snapshot, exactly as
   * it would against an older background). The harness keeps this object
   * MUTABLE: a `setAccountLabel` the page sends is applied to it, so the
   * follow-up `getAccountsView` reflects the rename the way production does. */
  accounts?: AccountsView;
  /** Deterministic replies for the status/hero runtime reads. Each field may be
   * a value OR a factory — a factory lets a test return a deferred promise
   * (signature-guard A→B race) or a rejecting promise (independent-source
   * failure), so one source can fail without stranding the other. */
  runtime?: {
    health?: AgencyHubHealthResponse | (() => AgencyHubHealthResponse | Promise<AgencyHubHealthResponse>);
    identity?: AgencyHubIdentityResponse | (() => AgencyHubIdentityResponse | Promise<AgencyHubIdentityResponse>);
    quotaByPage?: Record<string, AiQuotaStatus> | (() => Record<string, AiQuotaStatus> | Promise<Record<string, AiQuotaStatus>>);
    spenders?: SpendersObservation | null | (() => SpendersObservation | null | Promise<SpendersObservation | null>);
    opsDaily?: OpsDailySnapshot | (() => OpsDailySnapshot | Promise<OpsDailySnapshot>);
    /** «Выйти» outcome. The default 'revoked' also performs the background's
     * durable wipe on the harness record, so a test sees what the real
     * background would have left behind. A factory may reject. */
    signOut?: AgencyHubSignOutResponse | (() => AgencyHubSignOutResponse | Promise<AgencyHubSignOutResponse>);
    deviceTokenMeta?: AgencyHubDeviceTokenMeta | null;
    /** `false` makes every `setAccountLabel` fail the way a rejected storage
     * write does, so a test can prove the editor stays open with the typed text. */
    setAccountLabelOk?: boolean;
    /** `false` models a tab that closed between the view read and the click. */
    focusAccountTabOk?: boolean;
    /** First-run checklist flag. Omitted = the operation is UNAVAILABLE (an
     * older background), which the page must read as «not fresh» — no checklist.
     * Pass `{ version: 1, dismissedAt: null }` for a genuine first run. */
    onboarding?: OnboardingSnapshot;
    /** `false` makes `dismissOnboarding` answer «did not stick», so a test can
     * prove the checklist stays instead of silently disappearing. */
    dismissOnboardingOk?: boolean;
    /** Version whose changelog has already been opened. Omitted = none recorded
     * (also what an older background answers), which earns the «нов.» dot. */
    lastSeenVersion?: string | null;
    /** `false` models a rejected seen-version write: the dot must stay on. */
    setLastSeenVersionOk?: boolean;
    /** Reply for the mount-tail (and any post-mount) testAgencyHubConnection.
     * Defaults to a passing test so a fully-configured page reaches the hero's
     * all-green state — the hub step requires a `connected` feedback. A factory
     * may defer or fail the test. Ignored when `revealCatalogOnConnect` is set. */
    connection?: TestConnectionReply | (() => TestConnectionReply | Promise<TestConnectionReply>);
  };
}

type TestConnectionReply = { ok: true } | { ok: false; error?: unknown };

export function emptyOpsDaily(dateUtc = new Date().toISOString().slice(0, 10)): OpsDailySnapshot {
  return {
    version: 1,
    dateUtc,
    hubErrors: [],
    hubErrorsTotal: 0,
    lastGeneration: null,
    pageByAccount: {},
    lastSummaryPush: null,
  };
}

export interface MountedOptionsPage {
  document: Document;
  window: Window & typeof globalThis;
  /** Drain microtasks and any pending timers so render() settles. */
  flushAsync: () => Promise<void>;
  /** The in-memory storage record, normalized the way the app reads it. */
  getState: () => PersistedState;
  /** The raw storage record — for asserting operational/custody keys directly. */
  getRawStorage: () => Record<string, unknown>;
  /** Every runtime request type the page issued, in order. */
  sentRequestTypes: () => string[];
  /** Every `setAccountLabel` the page sent, in order. */
  labelWrites: () => Array<{ accountId: string; label: string }>;
  /** Every account the page asked to focus a tab for, in order. */
  focusRequests: () => string[];
  /** How many times the page asked to stamp the onboarding flag. */
  onboardingDismissals: () => number;
  /** Every version the page marked as seen, in order. */
  lastSeenWrites: () => string[];
  /** Every URL the page asked the browser to open in a new tab. */
  openedTabs: () => string[];
}

let dom: InstanceType<typeof JSDOM> | null = null;

/**
 * Mount the real options page (`src/options/index.ts`) against a fresh JSDOM
 * and an in-memory storage record. Deliberately slim: the older options suites
 * keep their own rich harnesses (stall/fail gates, storage-change emission,
 * reassignable state). This helper only stages enough for a test to mount the
 * cabinet, let it settle, and read back what was persisted.
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
  const sentRequestTypes: string[] = [];
  const labelWrites: Array<{ accountId: string; label: string }> = [];
  const focusRequests: string[] = [];
  const onboardingDismissals: number[] = [];
  const lastSeenWrites: string[] = [];
  const openedTabs: string[] = [];
  // Mutable so a label write is visible to the next view read, as in production.
  const accountsView: AccountsView | null = overrides.accounts
    ? structuredClone(overrides.accounts)
    : null;

  // v15 storage.local layout: credentials live in their own custody keys and
  // the `settings` blob is stripped of them. serializePersistedState is the
  // app's own writer, so the record the mocked storage hands back matches
  // production exactly; migrateState reconstructs it the way the page reads it.
  let stored: Record<string, unknown> = {
    ...serializePersistedState(state),
    ...overrides.storage,
  };

  dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatgoose-options-root"></div></body></html>',
    { url: `https://localhost/options.html${overrides.hash ?? ''}` },
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
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);

  const browserStub = {
    storage: {
      local: {
        // get(null) or get(key): the app reads the whole record and slices it
        // itself, so returning a clone of everything is sufficient and safe.
        get: vi.fn(async () => structuredClone(stored)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          stored = { ...stored, ...structuredClone(items) };
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
        if (typeof requestType === 'string') {
          sentRequestTypes.push(requestType);
        }
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
          // E51 durable-migration handshake: the page fails closed without it.
          case 'ensureStorageReady':
            return { ready: true };
          case 'getSessionsSnapshot': {
            const snapshot = await runtimeReply<SessionSnapshotEntry[]>(sessions, []);
            // The real handler reconciles `knownAccounts` inside this request
            // (storageCoordinator.reconcileKnownAccounts) — which is exactly why
            // the page re-reads storage once the snapshot resolves. Model the
            // UNION so a freshly captured account becomes known here too; the
            // background's pruning of stale unmapped ids is deliberately not
            // modelled (no suite depends on it, and a helper that removes rows
            // would be a surprise).
            const known = new Set(
              Array.isArray(stored[KNOWN_ACCOUNTS_KEY]) ? stored[KNOWN_ACCOUNTS_KEY] as string[] : [],
            );
            const before = known.size;
            for (const session of snapshot) {
              if (session.connected) {
                known.add(session.resolvedAccountId ?? session.legacyAccountId);
              }
            }
            if (known.size !== before) {
              stored = { ...stored, [KNOWN_ACCOUNTS_KEY]: [...known] };
            }
            return snapshot;
          }
          case 'testAgencyHubConnection':
            if (overrides.revealCatalogOnConnect) {
              // The background refresh onAgencyHubReady would fire has just landed:
              // publish the fresh catalog + matching source before the page's
              // post-connection-test readStorageState re-reads it.
              stored = {
                ...stored,
                personaCatalog: overrides.revealCatalogOnConnect.catalog,
                personaCatalogSource: overrides.revealCatalogOnConnect.source,
              };
              return { ok: true };
            }
            return runtimeReply<TestConnectionReply>(runtime.connection, { ok: true });
          case 'getAgencyHubHealth':
            return runtimeReply<AgencyHubHealthResponse>(runtime.health, { ok: false, reason: 'no_base_url' });
          case 'getAgencyHubIdentity':
            return runtimeReply<AgencyHubIdentityResponse>(runtime.identity, { ok: false, reason: 'no_credential' });
          case 'getAiQuotaByPage':
            return runtimeReply<Record<string, AiQuotaStatus>>(runtime.quotaByPage, {});
          case 'getAiQuotaStatus':
            return null;
          case 'getOpsDaily':
            return runtimeReply<OpsDailySnapshot>(runtime.opsDaily, emptyOpsDaily());
          case 'getSpendersStatus':
            return runtimeReply<SpendersObservation | null>(runtime.spenders, null);
          case 'getAccountsView':
            // `undefined` is what an older background answers — the page must
            // degrade instead of blanking the pane.
            return accountsView ? structuredClone(accountsView) : undefined;
          case 'setAccountLabel': {
            const { accountId, label } = message as { accountId: string; label: string };
            labelWrites.push({ accountId, label });
            if (runtime.setAccountLabelOk === false) {
              return { ok: false };
            }
            // Mirror the background: the labels store is the only writer, and the
            // row label prefers the local one.
            const entry = accountsView?.accounts.find(
              (candidate) => candidate.accountId === accountId,
            );
            if (entry) {
              const normalized = label.replace(/\s+/g, ' ').trim().slice(0, 60);
              entry.localLabel = normalized || null;
              if (normalized) entry.label = normalized;
            }
            return { ok: true };
          }
          case 'focusAccountTab': {
            const { accountId } = message as { accountId: string };
            focusRequests.push(accountId);
            return { ok: runtime.focusAccountTabOk !== false };
          }
          case 'getLastSeenVersion':
            return { version: 1, lastSeenVersion: runtime.lastSeenVersion ?? null };
          case 'setLastSeenVersion': {
            const { version } = message as { version: string };
            const ok = runtime.setLastSeenVersionOk !== false;
            if (ok) lastSeenWrites.push(version);
            return { ok };
          }
          case 'getOnboardingState':
            // No override = no handler, exactly like an older background.
            return runtime.onboarding;
          case 'dismissOnboarding': {
            const ok = runtime.dismissOnboardingOk !== false;
            if (ok) {
              // Mirror the background: the durable flag is stamped once and the
              // record is what a follow-up read would see.
              onboardingDismissals.push(Date.now());
            }
            return { ok };
          }
          case 'getAgencyHubDeviceTokenMeta': {
            if (runtime.deviceTokenMeta !== undefined) return runtime.deviceTokenMeta;
            const meta = stored[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY];
            return meta ?? null;
          }
          case 'signOutAgencyHub': {
            const reply = await runtimeReply<AgencyHubSignOutResponse>(
              runtime.signOut,
              { outcome: 'revoked' },
            );
            // The real background wipes BOTH custody keys (to empty strings —
            // never removal, E19) and the token metadata before it answers
            // anything but wipe-failed. Model that so the page under test sees
            // the same storage it would in production.
            if (reply.outcome !== 'wipe-failed') {
              stored = {
                ...stored,
                [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
                [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
              };
              delete stored[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY];
            }
            return reply;
          }
          default:
            return undefined;
        }
      }),
      openOptionsPage: vi.fn(async () => undefined),
    },
    tabs: {
      // Any tab-opening path (a readiness step, the Changelog link) is safe by
      // default; the URLs are recorded so a test can assert them.
      create: vi.fn(async (info?: { url?: string }) => {
        openedTabs.push(info?.url ?? '');
        return {};
      }),
    },
    permissions: {
      contains: vi.fn(async () => overrides.permissionGranted ?? false),
      request: vi.fn(async () => overrides.permissionGranted ?? false),
      // Real browsers fire these on a grant/revoke; wiring them lets a test drive
      // the permission-change hydration path (same-signature run ordering).
      onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  vi.stubGlobal('browser', browserStub);
  // The options page reads the GLOBAL `browser`; a test that re-points
  // sendMessage post-mount (the in-flight/sign-in signature-guard races) does so
  // via `window.browser`. Mirror the SAME object onto the JSDOM window so a
  // reassignment there mutates what the running module reads.
  (window as unknown as { browser: typeof browserStub }).browser = browserStub;

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
    getRawStorage: () => structuredClone(stored),
    sentRequestTypes: () => [...sentRequestTypes],
    labelWrites: () => labelWrites.map((entry) => ({ ...entry })),
    focusRequests: () => [...focusRequests],
    onboardingDismissals: () => onboardingDismissals.length,
    lastSeenWrites: () => [...lastSeenWrites],
    openedTabs: () => [...openedTabs],
  };
}

export async function unmountOptionsPage(): Promise<void> {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dom?.window.close();
  dom = null;
}
