import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { CLAUDE_MODELS, DEFAULT_FEATURE_MODELS, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import {
  BUNDLED_LORA_PERSONALITY_VERSION,
  createBundledPersonalities,
} from '../src/shared/personalities.js';
import type { FeatureType, PersistedState } from '../src/shared/types.js';

const EXPECTED_LABELS = ['Fast Reply', 'Ping', 'Help Me', 'Chat Review', 'Fan Summary'];
const EXPECTED_FEATURES: FeatureType[] = ['fast-reply', 'ping', 'help-me', 'chat-review', 'fan-summary'];

function makeState(overrides?: Partial<PersistedState['settings']>): PersistedState {
  const [bundledLora] = createBundledPersonalities();
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeApiKey: 'sk-test',
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      quickMessageCount: 30,
      pingMessageCount: 60,
      improveMessageCount: 45,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
      ...overrides,
    },
    personalities: [
      { id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 },
      ...(bundledLora ? [bundledLora] : []),
    ],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
  };
}

let dom: InstanceType<typeof JSDOM>;
let savedSettings: Record<string, unknown> | null;
let lastStorageSet: Record<string, unknown> | null;

function installDom() {
  dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatgoose-options-root"></div></body></html>',
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
  lastStorageSet = null;

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => state),
        set: vi.fn(async (data: Record<string, unknown>) => {
          lastStorageSet = data;
          if (data.settings) {
            savedSettings = data.settings as Record<string, unknown>;
          }
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      sendMessage: vi.fn(async () => []),
      openOptionsPage: vi.fn(async () => undefined),
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    },
  };

  await import('../src/options/index.js');
  // render() is fire-and-forget (void render()), wait for it
  await vi.waitFor(() => {
    const root = document.getElementById('chatgoose-options-root')!;
    if (!root.querySelector('select.chatgoose-select')) {
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

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatgoose-select');
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

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatgoose-select');

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

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatgoose-select');

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

  it('initializes the separate improve message count input from persisted settings', async () => {
    await loadOptionsPage(makeState({ improveMessageCount: 77 }));

    const labels = Array.from(document.querySelectorAll('label'));
    const improveLabel = labels.find((label) =>
      label.textContent?.includes('Fix message count'),
    );
    const input = improveLabel?.querySelector<HTMLInputElement>('input[type="number"]');

    expect(input?.value).toBe('77');
  });

  it('initializes the separate ping message count input from persisted settings', async () => {
    await loadOptionsPage(makeState({ pingMessageCount: 66 }));

    const labels = Array.from(document.querySelectorAll('label'));
    const pingLabel = labels.find((label) =>
      label.textContent?.includes('Ping message count'),
    );
    const input = pingLabel?.querySelector<HTMLInputElement>('input[type="number"]');

    expect(input?.value).toBe('66');
  });

  it('renders the deep message count input with a 3000 upper bound', async () => {
    await loadOptionsPage(makeState({ deepMessageCount: 2500 }));

    const labels = Array.from(document.querySelectorAll('label'));
    const deepLabel = labels.find((label) =>
      label.textContent?.includes('Deep feature message count'),
    );
    const input = deepLabel?.querySelector<HTMLInputElement>('input[type="number"]');

    expect(input?.value).toBe('2500');
    expect(input?.max).toBe('3000');
  });

  it('saves featureModels when a dropdown changes', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatgoose-options-root')!;
    const summarySelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-feature="fan-summary"]',
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

  it('saves improveMessageCount when the improve input changes', async () => {
    await loadOptionsPage(makeState());

    const labels = Array.from(document.querySelectorAll('label'));
    const improveLabel = labels.find((label) =>
      label.textContent?.includes('Fix message count'),
    );
    const input = improveLabel?.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) {
      throw new Error('Fix message count input not found');
    }

    input.value = '88';
    input.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { improveMessageCount?: number };
    expect(saved.improveMessageCount).toBe(88);
  });

  it('saves pingMessageCount when the ping input changes', async () => {
    await loadOptionsPage(makeState());

    const labels = Array.from(document.querySelectorAll('label'));
    const pingLabel = labels.find((label) =>
      label.textContent?.includes('Ping message count'),
    );
    const input = pingLabel?.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) {
      throw new Error('Ping message count input not found');
    }

    input.value = '91';
    input.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { pingMessageCount?: number };
    expect(saved.pingMessageCount).toBe(91);
  });

  it('preserves builtin personality metadata when editing the bundled Lora entry', async () => {
    await loadOptionsPage({
      ...makeState(),
      personalities: [
        {
          id: 'builtin:lora',
          name: 'Lora',
          content: 'original bundled content',
          updatedAt: 1,
          builtin: true,
          builtinVersion: BUNDLED_LORA_PERSONALITY_VERSION,
        },
      ],
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-role="content"]');
    if (!textarea) {
      throw new Error('Personality content textarea not found');
    }

    textarea.value = 'edited bundled content';
    textarea.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!lastStorageSet?.personalities) {
        throw new Error('personalities were not saved yet');
      }
    }, { timeout: 2000 });

    const saved = lastStorageSet as { personalities: Array<Record<string, unknown>> };
    expect(saved.personalities[0]).toMatchObject({
      id: 'builtin:lora',
      builtin: true,
      builtinVersion: BUNDLED_LORA_PERSONALITY_VERSION,
      content: 'edited bundled content',
    });
  });
});
