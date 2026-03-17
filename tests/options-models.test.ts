import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_FEATURE_MODELS,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { getModelsForProvider } from '../src/shared/claude-models.js';
import type { FeatureType, PersistedState } from '../src/shared/types.js';

const EXPECTED_LABELS = ['Fast Reply', 'Ping', 'Help Me', 'Chat Review', 'Fan Summary'];
const EXPECTED_FEATURES: FeatureType[] = ['fast-reply', 'ping', 'help-me', 'chat-review', 'fan-summary'];

function makeState(overrides?: Partial<PersistedState['settings']>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-test',
      kiroApiKey: 'sk-aw-test',
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
  let currentState: PersistedState = {
    ...state,
    settings: {
      ...state.settings,
      featureModels: { ...state.settings.featureModels },
    },
  };

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => currentState),
        set: vi.fn(async (data: Record<string, unknown>) => {
          if (data.settings) {
            savedSettings = data.settings as Record<string, unknown>;
            currentState = {
              ...currentState,
              settings: data.settings as PersistedState['settings'],
            };
          }
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (message: { type: string }) => {
        if (message.type === 'getSessionsSnapshot') {
          return [];
        }
        if (message.type === 'getProviderDiagnostics') {
          return {
            provider: currentState.settings.claudeProvider,
            displayName: currentState.settings.claudeProvider === 'kiro' ? 'Kiro' : 'Anthropic',
            requestUrl:
              currentState.settings.claudeProvider === 'kiro'
                ? 'https://api.kiro.cheap/v1/messages'
                : 'https://api.anthropic.com/v1/messages',
            requestHost:
              currentState.settings.claudeProvider === 'kiro'
                ? 'api.kiro.cheap'
                : 'api.anthropic.com',
            hostPermissionPattern:
              currentState.settings.claudeProvider === 'kiro'
                ? '*://api.kiro.cheap/*'
                : '*://api.anthropic.com/*',
            hostPermissionGranted: true,
            hasApiKey: true,
            capabilityStatus: 'ready',
            buildTime: 'test-build',
          };
        }
        if (message.type === 'runProviderConnectionTest') {
          return {
            provider: currentState.settings.claudeProvider,
            displayName: currentState.settings.claudeProvider === 'kiro' ? 'Kiro' : 'Anthropic',
            requestUrl:
              currentState.settings.claudeProvider === 'kiro'
                ? 'https://api.kiro.cheap/v1/messages'
                : 'https://api.anthropic.com/v1/messages',
            requestHost:
              currentState.settings.claudeProvider === 'kiro'
                ? 'api.kiro.cheap'
                : 'api.anthropic.com',
            hostPermissionPattern:
              currentState.settings.claudeProvider === 'kiro'
                ? '*://api.kiro.cheap/*'
                : '*://api.anthropic.com/*',
            hostPermissionGranted: true,
            hasApiKey: true,
            capabilityStatus: 'ready',
            buildTime: 'test-build',
            status: 'ready',
            checkedAt: 0,
            detail: 'Connection test succeeded.',
            httpStatus: 200,
          };
        }
        return [];
      }),
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
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
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select[data-feature]');
    expect(selects.length).toBe(5);

    const features = Array.from(selects).map((s) => s.dataset.feature);
    expect(features).toEqual(EXPECTED_FEATURES);

    const labels = Array.from(selects).map((s) => {
      const row = s.parentElement!;
      return row.querySelector('span')!.textContent;
    });
    expect(labels).toEqual(EXPECTED_LABELS);
  });

  it('each Anthropic dropdown contains the Anthropic model list in registry order', async () => {
    await loadOptionsPage(makeState());

    const root = document.getElementById('chatmuse-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select[data-feature]');
    const anthropicModels = getModelsForProvider('anthropic');

    for (const select of selects) {
      const options = Array.from(select.options);
      expect(options.length).toBe(anthropicModels.length);
      options.forEach((opt, i) => {
        expect(opt.value).toBe(anthropicModels[i]!.id);
      });
    }
  });

  it('switches to the Kiro model list, resets unsupported models, and shows a note', async () => {
    await loadOptionsPage(makeState({
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fast-reply': 'claude-sonnet-4-6',
      },
    }));

    const providerSelect = document.querySelector<HTMLSelectElement>('[data-role="claude-provider-select"]');
    const replySelect = document.querySelector<HTMLSelectElement>(
      'select.chatmuse-select[data-feature="fast-reply"]',
    );
    if (!providerSelect || !replySelect) {
      throw new Error('Provider or model select not found');
    }

    providerSelect.value = 'kiro';
    providerSelect.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      if (!savedSettings) {
        throw new Error('settings not saved yet');
      }
      expect((savedSettings as { claudeProvider?: string }).claudeProvider).toBe('kiro');
    }, { timeout: 2000 });

    const kiroModels = getModelsForProvider('kiro');
    expect(Array.from(replySelect.options).map((option) => option.value)).toEqual(
      kiroModels.map((model) => model.id),
    );
    expect(replySelect.value).toBe('claude-sonnet-4-5');
    expect(document.body.textContent).toContain(
      '5 model selections changed to Sonnet 4.5 because their previous models are not available on Kiro.',
    );
  });

  it('initializes dropdowns from persisted featureModels', async () => {
    const customModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fan-summary': 'claude-opus-4-6',
      'ping': 'claude-haiku-4-5',
    };
    await loadOptionsPage(makeState({ featureModels: customModels }));

    const root = document.getElementById('chatmuse-options-root')!;
    const selects = root.querySelectorAll<HTMLSelectElement>('select.chatmuse-select[data-feature]');

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

  it('renders the provider selector', async () => {
    await loadOptionsPage(makeState({ claudeProvider: 'kiro' }));

    const providerSelect = document.querySelector<HTMLSelectElement>('[data-role="claude-provider-select"]');
    expect(providerSelect?.value).toBe('kiro');
    expect(Array.from(providerSelect?.options ?? []).map((option) => option.value)).toEqual([
      'anthropic',
      'kiro',
    ]);
  });

  it('shows only the Anthropic key field when Anthropic is selected', async () => {
    await loadOptionsPage(makeState({ claudeProvider: 'anthropic' }));

    const anthropicField = document.querySelector<HTMLElement>('input[data-role="anthropic-api-key-input"]')?.closest('label');
    const kiroField = document.querySelector<HTMLElement>('input[data-role="kiro-api-key-input"]')?.closest('label');

    expect(anthropicField?.style.display).toBe('grid');
    expect(kiroField?.style.display).toBe('none');
    expect(anthropicField?.textContent).toContain('Anthropic API key');
    expect(anthropicField?.textContent).toContain('Regular Claude/Anthropic API key');
  });

  it('shows only the Kiro key field when Kiro is selected', async () => {
    await loadOptionsPage(makeState({ claudeProvider: 'kiro' }));

    const anthropicField = document.querySelector<HTMLElement>('input[data-role="anthropic-api-key-input"]')?.closest('label');
    const kiroField = document.querySelector<HTMLElement>('input[data-role="kiro-api-key-input"]')?.closest('label');

    expect(anthropicField?.style.display).toBe('none');
    expect(kiroField?.style.display).toBe('grid');
    expect(kiroField?.textContent).toContain('Kiro API key');
    expect(kiroField?.textContent).toContain('Kiro/AWStore API key');
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

  it('saves provider selection when the selector changes', async () => {
    await loadOptionsPage(makeState());

    const providerSelect = document.querySelector<HTMLSelectElement>('[data-role="claude-provider-select"]');
    if (!providerSelect) {
      throw new Error('Provider selector not found');
    }

    providerSelect.value = 'kiro';
    providerSelect.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('not saved yet');
    }, { timeout: 2000 });

    const saved = savedSettings as { claudeProvider?: string };
    expect(saved.claudeProvider).toBe('kiro');
  });

  it('saves separate Anthropic and Kiro keys correctly', async () => {
    await loadOptionsPage(makeState());

    const anthropicInput = document.querySelector<HTMLInputElement>('input[data-role="anthropic-api-key-input"]');
    const providerSelect = document.querySelector<HTMLSelectElement>('[data-role="claude-provider-select"]');
    const kiroInput = document.querySelector<HTMLInputElement>('input[data-role="kiro-api-key-input"]');

    if (!anthropicInput || !providerSelect || !kiroInput) {
      throw new Error('Provider inputs not found');
    }

    anthropicInput.value = 'sk-ant-updated';
    anthropicInput.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('Anthropic key not saved yet');
    }, { timeout: 2000 });
    expect((savedSettings as { anthropicApiKey?: string }).anthropicApiKey).toBe('sk-ant-updated');

    providerSelect.value = 'kiro';
    providerSelect.dispatchEvent(new Event('change'));
    kiroInput.value = 'sk-aw-updated';
    kiroInput.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) throw new Error('Kiro key not saved yet');
      expect((savedSettings as { kiroApiKey?: string }).kiroApiKey).toBe('sk-aw-updated');
    }, { timeout: 2000 });

    const saved = savedSettings as {
      claudeProvider?: string;
      anthropicApiKey?: string;
      kiroApiKey?: string;
    };
    expect(saved.claudeProvider).toBe('kiro');
    expect(saved.anthropicApiKey).toBe('sk-ant-updated');
    expect(saved.kiroApiKey).toBe('sk-aw-updated');
  });

  it('does not render the raw base URL field or Grant access controls', async () => {
    await loadOptionsPage(makeState());

    expect(document.body.textContent).not.toContain('Claude API Base URL');
    expect(document.body.textContent).not.toContain('Grant access');
    expect(document.querySelector('[data-role="proxy-permission-status"]')).toBeNull();
  });
});
