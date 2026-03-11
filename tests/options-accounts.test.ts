import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { DEFAULT_FEATURE_MODELS, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { PersistedState, SessionSnapshotEntry } from '../src/shared/types.js';

let dom: InstanceType<typeof JSDOM>;
let currentState: PersistedState;
let currentSessions: SessionSnapshotEntry[] = [];
let callOrder: string[] = [];
let onSnapshotRequest: (() => void) | null = null;

function makeState(overrides?: Partial<PersistedState>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeApiKey: 'sk-test',
      quickMessageCount: 30,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
    },
    personalities: [{ id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 }],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

function installDom() {
  dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatmuse-options-root"></div></body></html>',
    { url: 'https://example.test/options.html' },
  );
  const { window } = dom;

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
}

function getSectionByTitle(title: string): HTMLElement {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('section'));
  const section = sections.find(
    (candidate) => candidate.querySelector('h2')?.textContent === title,
  );

  if (!section) {
    throw new Error(`Missing section: ${title}`);
  }

  return section;
}

async function loadOptionsPage(options: {
  state: PersistedState;
  sessions: SessionSnapshotEntry[];
  onSnapshotRequest?: () => void;
}): Promise<void> {
  vi.resetModules();
  installDom();
  currentState = options.state;
  currentSessions = options.sessions;
  callOrder = [];
  onSnapshotRequest = options.onSnapshotRequest ?? null;

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => {
          callOrder.push('storage');
          return currentState;
        }),
        set: vi.fn(async (items: Partial<PersistedState>) => {
          currentState = {
            ...currentState,
            ...items,
          };
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => {
        callOrder.push('snapshot');
        onSnapshotRequest?.();
        return currentSessions;
      }),
      openOptionsPage: vi.fn(async () => undefined),
    },
  };

  await import('../src/options/index.js');
  await vi.waitFor(() => {
    getSectionByTitle('Connection Status');
  }, { timeout: 2000 });
}

describe('Options page account sections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads the snapshot before storage and keeps connection status separate from offline mappings', async () => {
    await loadOptionsPage({
      state: makeState({
        accountMappings: {
          mappedOffline: 'p1',
        },
        knownAccounts: ['mappedOffline', 'stale'],
      }),
      sessions: [
        {
          legacyAccountId: 'legacy',
          resolvedAccountId: 'active-resolved',
          username: 'creator',
          displayName: 'Creator',
          connected: true,
          lastSeenAt: 20,
        },
      ],
      onSnapshotRequest: () => {
        currentState = makeState({
          accountMappings: {
            mappedOffline: 'p1',
          },
          knownAccounts: ['active-resolved', 'mappedOffline'],
        });
      },
    });

    const mappingsSection = getSectionByTitle('Account Mappings');
    const connectionSection = getSectionByTitle('Connection Status');

    expect(callOrder.slice(0, 2)).toEqual(['snapshot', 'storage']);
    expect(mappingsSection.textContent).toContain('Account ID: active-resolved');
    expect(mappingsSection.textContent).toContain('Account ID: mappedOffline');
    expect(mappingsSection.textContent).not.toContain('stale');
    expect(connectionSection.textContent).toContain('Account ID: active-resolved');
    expect(connectionSection.textContent).not.toContain('mappedOffline');
    expect(connectionSection.textContent).not.toContain('stale');
  });

  it('dedupes connection status rows by canonical account id using the newest snapshot entry', async () => {
    await loadOptionsPage({
      state: makeState(),
      sessions: [
        {
          legacyAccountId: 'legacy-1',
          resolvedAccountId: 'resolved',
          username: 'older',
          displayName: 'Older',
          connected: true,
          lastSeenAt: 10,
        },
        {
          legacyAccountId: 'legacy-2',
          resolvedAccountId: 'resolved',
          username: 'newer',
          displayName: 'Newer',
          connected: true,
          lastSeenAt: 20,
        },
      ],
    });

    const connectionSection = getSectionByTitle('Connection Status');
    const cards = connectionSection.querySelectorAll('.chatmuse-card');

    expect(cards).toHaveLength(1);
    expect(connectionSection.textContent).toContain('Newer');
    expect(connectionSection.textContent).not.toContain('Older');
    expect(connectionSection.textContent).toContain('Account ID: resolved');
  });
});
