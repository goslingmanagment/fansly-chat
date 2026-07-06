import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  AI_MODELS,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
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
      openRouterApiKey: '',
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
      quickMessageCount: 30,
      pingMessageCount: 60,
      improveMessageCount: 45,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
      featureReasoning: { ...DEFAULT_FEATURE_REASONING },
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
    const selects = root.querySelectorAll<HTMLSelectElement>(
      'select.chatgoose-select[data-feature]',
    );
    expect(selects.length).toBe(5);

    const features = Array.from(selects).map((s) => s.dataset.feature);
    expect(features).toEqual(EXPECTED_FEATURES);

    const labels = Array.from(selects).map((s) => {
      const row = s.closest('.chatgoose-model-config-grid')!.parentElement!;
      return row.querySelector('span')!.textContent;
    });
    expect(labels).toEqual(EXPECTED_LABELS);
  });

  it('each dropdown contains all AI models grouped by provider in registry order', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>(
      'select.chatgoose-select[data-feature]',
    );

    for (const select of selects) {
      const options = Array.from(select.options);
      expect(options.length).toBe(AI_MODELS.length);
      options.forEach((opt, i) => {
        expect(opt.value).toBe(AI_MODELS[i]!.id);
      });
      expect(Array.from(select.querySelectorAll('optgroup')).map((group) => group.label)).toEqual([
        'Anthropic Direct',
        'OpenRouter',
      ]);
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
    const selects = root.querySelectorAll<HTMLSelectElement>(
      'select.chatgoose-select[data-feature]',
    );

    const values: Record<string, string> = {};
    for (const select of selects) {
      values[select.dataset.feature!] = select.value;
    }
    expect(values['fan-summary']).toBe('anthropic:claude-opus-4-6');
    expect(values['ping']).toBe('anthropic:claude-haiku-4-5');
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

  it('renders an OpenRouter API key field', async () => {
    await loadOptionsPage(makeState({ openRouterApiKey: 'sk-or-v1-test' }));

    const labels = Array.from(document.querySelectorAll('label'));
    const openRouterLabel = labels.find((label) =>
      label.textContent?.includes('OpenRouter API key'),
    );
    const input = openRouterLabel?.querySelector<HTMLInputElement>('input[type="password"]');

    expect(input?.value).toBe('sk-or-v1-test');
  });

  it('warns when an OpenRouter model is selected without an OpenRouter key', async () => {
    await loadOptionsPage(makeState({
      openRouterApiKey: '',
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fast-reply': 'openrouter:x-ai/grok-4.3',
      },
    }));

    expect(document.body.textContent).toContain(
      'OpenRouter model selected: add an OpenRouter API key before using those features.',
    );
  });

  it('renders 5 reasoning dropdowns with default medium options', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature]',
    );

    expect(selects.length).toBe(5);
    expect(Array.from(selects).map((select) => select.dataset.reasoningFeature)).toEqual(
      EXPECTED_FEATURES,
    );
    for (const select of selects) {
      expect(select.value).toBe('medium');
      expect(Array.from(select.options).map((option) => option.value)).toEqual([
        'off',
        'low',
        'medium',
        'high',
        'max',
      ]);
    }
  });

  it('initializes reasoning dropdowns from persisted featureReasoning', async () => {
    await loadOptionsPage(makeState({
      featureReasoning: {
        ...DEFAULT_FEATURE_REASONING,
        'fast-reply': 'off',
        'fan-summary': 'max',
      },
    }));

    const root = document.getElementById('chatgoose-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature]',
    );

    const values: Record<string, string> = {};
    for (const select of selects) {
      values[select.dataset.reasoningFeature!] = select.value;
    }
    expect(values['fast-reply']).toBe('off');
    expect(values['fan-summary']).toBe('max');
    expect(values.ping).toBe('medium');
  });

  it('keeps saved reasoning values while disabling unsupported model-feature pairs', async () => {
    await loadOptionsPage(makeState({
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fan-summary': 'openrouter:google/gemini-3.1-pro-preview',
        'fast-reply': 'openrouter:x-ai/grok-4.3',
      },
      featureReasoning: {
        ...DEFAULT_FEATURE_REASONING,
        'fan-summary': 'max',
        'fast-reply': 'high',
      },
    }));

    const root = document.getElementById('chatgoose-options-root')!;
    const summaryReasoningSelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature="fan-summary"]',
    )!;
    const replyReasoningSelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature="fast-reply"]',
    )!;

    expect(summaryReasoningSelect.value).toBe('max');
    expect(summaryReasoningSelect.disabled).toBe(true);
    expect(summaryReasoningSelect.dataset.reasoningSupported).toBe('false');
    expect(replyReasoningSelect.value).toBe('high');
    expect(replyReasoningSelect.disabled).toBe(true);
    expect(replyReasoningSelect.dataset.reasoningSupported).toBe('false');
  });

  it('updates reasoning capability when the selected model changes', async () => {
    await loadOptionsPage(makeState({
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fast-reply': 'openrouter:x-ai/grok-4.3',
      },
    }));

    const root = document.getElementById('chatgoose-options-root')!;
    const replyModelSelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-feature="fast-reply"]',
    )!;
    const replyReasoningSelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature="fast-reply"]',
    )!;

    expect(replyReasoningSelect.disabled).toBe(true);

    replyModelSelect.value = 'openrouter:google/gemini-3.1-pro-preview';
    replyModelSelect.dispatchEvent(new Event('change'));

    expect(replyReasoningSelect.disabled).toBe(false);
    expect(replyReasoningSelect.dataset.reasoningSupported).toBe('true');
    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });
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

    summarySelect.value = 'anthropic:claude-opus-4-6';
    summarySelect.dispatchEvent(new Event('change'));

    // Wait for debounced save (350ms)
    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { featureModels?: Record<string, string> };
    expect(saved.featureModels).toBeDefined();
    expect(saved.featureModels!['fan-summary']).toBe('anthropic:claude-opus-4-6');
  });

  it('saves featureReasoning when a reasoning dropdown changes', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatgoose-options-root')!;
    const summaryReasoningSelect = root.querySelector<HTMLSelectElement>(
      'select.chatgoose-select[data-reasoning-feature="fan-summary"]',
    )!;

    summaryReasoningSelect.value = 'max';
    summaryReasoningSelect.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { featureReasoning?: Record<string, string> };
    expect(saved.featureReasoning).toBeDefined();
    expect(saved.featureReasoning!['fan-summary']).toBe('max');
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
