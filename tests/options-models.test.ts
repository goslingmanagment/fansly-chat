import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { CLAUDE_MODELS, DEFAULT_FEATURE_MODELS, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { FeatureType, PersistedState } from '../src/shared/types.js';

const EXPECTED_LABELS = ['Fast Reply', 'Ping', 'Help Me', 'Chat Review', 'Fan Summary'];
const EXPECTED_FEATURES: FeatureType[] = ['fast-reply', 'ping', 'help-me', 'chat-review', 'fan-summary'];

function makeState(overrides?: Partial<PersistedState['settings']>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeApiKey: 'sk-test',
      quickMessageCount: 30,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
      ...overrides,
    },
    personalities: [{ id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 }],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
  };
}

let dom: InstanceType<typeof JSDOM>;
let savedSettings: Record<string, unknown> | null;

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

async function loadOptionsPage(state: PersistedState): Promise<void> {
  savedSettings = null;

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => state),
        set: vi.fn(async (data: Record<string, unknown>) => {
          if (data.settings) {
            savedSettings = data.settings as Record<string, unknown>;
          }
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      sendMessage: vi.fn(async () => []),
      openOptionsPage: vi.fn(async () => undefined),
    },
  };

  await import('../src/options/index.js');
  // render() is fire-and-forget (void render()), wait for it
  await vi.waitFor(() => {
    const root = document.getElementById('chatmuse-options-root')!;
    if (!root.querySelector('select.chatmuse-select')) {
      throw new Error('selects not rendered yet');
    }
  }, { timeout: 2000 });
}

describe('Options page — AI Models section', () => {
  beforeEach(() => {
    vi.resetModules();
    installDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders 5 model dropdowns with correct feature labels and order', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatmuse-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select');
    expect(selects.length).toBe(5);

    const features = Array.from(selects).map((s) => s.dataset.feature);
    expect(features).toEqual(EXPECTED_FEATURES);

    const labels = Array.from(selects).map((s) => {
      const row = s.parentElement!;
      return row.querySelector('span')!.textContent;
    });
    expect(labels).toEqual(EXPECTED_LABELS);
  });

  it('each dropdown contains all CLAUDE_MODELS in registry order', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatmuse-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select');

    for (const select of selects) {
      const options = Array.from(select.options);
      expect(options.length).toBe(CLAUDE_MODELS.length);
      options.forEach((opt, i) => {
        expect(opt.value).toBe(CLAUDE_MODELS[i]!.id);
      });
    }
  });

  it('initializes dropdowns from persisted featureModels', async () => {
    const customModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fan-summary': 'claude-opus-4-6',
      'ping': 'claude-haiku-4-5',
    };
    await loadOptionsPage(makeState({ featureModels: customModels }));

    const root = document.getElementById('chatmuse-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select');

    const values: Record<string, string> = {};
    for (const select of selects) {
      values[select.dataset.feature!] = select.value;
    }
    expect(values['fan-summary']).toBe('claude-opus-4-6');
    expect(values['ping']).toBe('claude-haiku-4-5');
    expect(values['fast-reply']).toBe(DEFAULT_FEATURE_MODELS['fast-reply']);
  });

  it('renders prompt caching enabled by default', async () => {
    await loadOptionsPage(makeState());

    const labels = Array.from(document.querySelectorAll('label'));
    const promptCachingLabel = labels.find((label) =>
      label.textContent?.includes('Enable prompt caching'),
    );
    const checkbox = promptCachingLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    expect(checkbox?.checked).toBe(true);
  });

  it('saves featureModels when a dropdown changes', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatmuse-options-root')!;
    const summarySelect = root.querySelector<HTMLSelectElement>(
      'select.chatmuse-select[data-feature="fan-summary"]',
    )!;

    summarySelect.value = 'claude-opus-4-6';
    summarySelect.dispatchEvent(new Event('change'));

    // Wait for debounced save (350ms)
    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { featureModels?: Record<string, string> };
    expect(saved.featureModels).toBeDefined();
    expect(saved.featureModels!['fan-summary']).toBe('claude-opus-4-6');
  });

  it('saves promptCachingEnabled when the checkbox changes', async () => {
    await loadOptionsPage(makeState());

    const labels = Array.from(document.querySelectorAll('label'));
    const promptCachingLabel = labels.find((label) =>
      label.textContent?.includes('Enable prompt caching'),
    );
    const checkbox = promptCachingLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) {
      throw new Error('Prompt caching checkbox not found');
    }

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { promptCachingEnabled?: boolean };
    expect(saved.promptCachingEnabled).toBe(false);
  });
});
