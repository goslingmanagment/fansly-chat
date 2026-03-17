import optionsStyles from './styles.css';
import {
  getClaudeProviderConfig,
  normalizeClaudeProvider,
} from '../shared/claude-api.js';
import {
  getDefaultModelId,
  getModelLabel,
  getModelsForProvider,
  normalizeFeatureModelsForProvider,
} from '../shared/claude-models.js';
import { saveSettings, loadStorageState, savePersonalities, saveAccountMapping, deletePersonality } from '../shared/storage.js';
import type {
  ClaudeProvider,
  FeatureType,
  Personality,
  ProviderConnectionTestResult,
  ProviderDiagnostics,
  SessionSnapshotEntry,
} from '../shared/types.js';

const rootElement = document.getElementById('chatmuse-options-root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing options root');
}

const root = rootElement;

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = optionsStyles;
  document.head.append(style);
}

function createSection(title: string, description?: string): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.style.display = 'grid';
  wrapper.style.gap = '12px';
  wrapper.style.padding = '20px';
  wrapper.style.margin = '20px';
  wrapper.style.borderRadius = '24px';
  wrapper.style.border = '1px solid rgba(255,255,255,0.08)';
  wrapper.style.background = 'rgba(12, 21, 29, 0.88)';

  const heading = document.createElement('div');
  heading.style.display = 'grid';
  heading.style.gap = '4px';

  const titleNode = document.createElement('h2');
  titleNode.textContent = title;
  titleNode.style.margin = '0';

  heading.append(titleNode);
  if (description) {
    const copy = document.createElement('div');
    copy.textContent = description;
    copy.style.color = 'var(--chatmuse-muted)';
    copy.style.fontSize = '14px';
    heading.append(copy);
  }

  wrapper.append(heading);
  return wrapper;
}

function labeledField(labelText: string, input: HTMLElement): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.style.display = 'grid';
  wrapper.style.gap = '8px';
  const label = document.createElement('span');
  label.textContent = labelText;
  label.style.fontWeight = '700';
  wrapper.append(label, input);
  return wrapper;
}

function createFieldNote(text: string): HTMLElement {
  const note = document.createElement('div');
  note.textContent = text;
  note.style.color = 'var(--chatmuse-muted)';
  note.style.fontSize = '13px';
  return note;
}

function createButton(label: string, secondary = false, danger = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chatmuse-button${secondary ? ' chatmuse-button-secondary' : ''}${danger ? ' chatmuse-button-danger' : ''}`;
  button.textContent = label;
  return button;
}

function debounce<T extends (...args: never[]) => void>(callback: T, waitMs: number): T {
  let timer: number | null = null;
  return ((...args: never[]) => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => callback(...args), waitMs);
  }) as T;
}

function getNormalizedUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, '') ?? '';
  return normalized || null;
}

function formatAccountHeading(accountId: string, session: SessionSnapshotEntry | null | undefined): string {
  const displayName = session?.displayName?.trim() || null;
  const username = getNormalizedUsername(session?.username);

  if (displayName && username && displayName.replace(/^@+/, '') !== username) {
    return `${displayName} (@${username})`;
  }
  if (username) {
    return `@${username}`;
  }
  if (displayName) {
    return displayName;
  }
  return session?.resolvedAccountId ?? accountId;
}

function formatAccountMeta(accountId: string, session: SessionSnapshotEntry | null | undefined): string {
  const resolvedAccountId = session?.resolvedAccountId ?? accountId;
  return `Account ID: ${resolvedAccountId}`;
}

function buildSessionLookup(sessions: SessionSnapshotEntry[]): Map<string, SessionSnapshotEntry> {
  const lookup = new Map<string, SessionSnapshotEntry>();

  sessions.forEach((session) => {
    lookup.set(session.legacyAccountId, session);
    if (session.resolvedAccountId) {
      lookup.set(session.resolvedAccountId, session);
    }
  });

  return lookup;
}

function buildConnectionRows(
  sessions: SessionSnapshotEntry[],
): Array<{ accountId: string; session: SessionSnapshotEntry }> {
  const deduped = new Map<string, SessionSnapshotEntry>();

  sessions.forEach((session) => {
    const canonicalAccountId = session.resolvedAccountId ?? session.legacyAccountId;
    const existing = deduped.get(canonicalAccountId);
    if (!existing || session.lastSeenAt > existing.lastSeenAt) {
      deduped.set(canonicalAccountId, session);
    }
  });

  return Array.from(deduped.entries()).map(([accountId, session]) => ({
    accountId,
    session,
  }));
}

function formatBuildTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatCapabilityLabel(diagnostics: ProviderDiagnostics): string {
  switch (diagnostics.capabilityStatus) {
    case 'ready':
      return 'Ready';
    case 'missing_api_key':
      return 'API key missing';
    case 'host_access_missing':
      return 'Host access missing';
    default:
      return 'Unknown';
  }
}

function formatTestStatusLabel(result: ProviderConnectionTestResult): string {
  switch (result.status) {
    case 'ready':
      return 'Connection test passed';
    case 'missing_api_key':
      return 'API key missing';
    case 'host_access_missing':
      return 'Host access missing';
    case 'invalid_api_key':
      return 'Invalid API key';
    case 'http_error':
      return result.httpStatus ? `Provider HTTP ${result.httpStatus}` : 'Provider HTTP error';
    case 'pre_response_failure':
      return 'Blocked before response';
    default:
      return 'Unknown';
  }
}

async function render(): Promise<void> {
  const [sessions, state, initialProviderDiagnostics] = await Promise.all([
    browser.runtime.sendMessage({ type: 'getSessionsSnapshot' }) as Promise<SessionSnapshotEntry[]>,
    loadStorageState(),
    browser.runtime.sendMessage({ type: 'getProviderDiagnostics' }) as Promise<ProviderDiagnostics>,
  ]);
  const sessionsByAccountId = buildSessionLookup(sessions);

  root.replaceChildren();
  root.style.paddingBottom = '24px';

  // ─── Hero ──────────────────────────────────────────────────
  const hero = document.createElement('div');
  hero.style.padding = '28px 20px 4px';
  hero.style.display = 'grid';
  hero.style.gap = '8px';
  const title = document.createElement('h1');
  title.textContent = 'ChatMuse Settings';
  title.style.margin = '0';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'Configure Anthropic or Kiro, personalities, mappings, and live Fansly connections.';
  subtitle.style.color = 'var(--chatmuse-muted)';
  hero.append(title, subtitle);
  root.append(hero);

  // ─── API Configuration ─────────────────────────────────────
  const apiSection = createSection('API Configuration');
  let currentProvider = normalizeClaudeProvider(state.settings.claudeProvider);
  let anthropicApiKey = state.settings.anthropicApiKey;
  let kiroApiKey = state.settings.kiroApiKey;

  const providerSelect = document.createElement('select');
  providerSelect.className = 'chatmuse-select';
  providerSelect.dataset.role = 'claude-provider-select';
  for (const provider of ['anthropic', 'kiro'] as ClaudeProvider[]) {
    const option = document.createElement('option');
    option.value = provider;
    option.textContent = getClaudeProviderConfig(provider).displayName;
    providerSelect.append(option);
  }
  providerSelect.value = currentProvider;
  apiSection.append(labeledField('Provider', providerSelect));

  function createProviderKeyField(
    provider: ClaudeProvider,
    initialValue: string,
  ): { wrapper: HTMLElement; input: HTMLInputElement } {
    const config = getClaudeProviderConfig(provider);
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'chatmuse-input';
    input.value = initialValue;
    input.dataset.role = `${provider}-api-key-input`;

    const toggle = createButton('Show', true);
    toggle.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
    });

    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr auto';
    row.style.gap = '8px';
    row.append(input, toggle);

    const field = document.createElement('div');
    field.style.display = 'grid';
    field.style.gap = '6px';
    field.dataset.role = `${provider}-api-key-field`;
    field.append(row, createFieldNote(config.apiKeyHelperText));

    return {
      wrapper: labeledField(config.apiKeyLabel, field),
      input,
    };
  }

  const anthropicKeyField = createProviderKeyField('anthropic', anthropicApiKey);
  const kiroKeyField = createProviderKeyField('kiro', kiroApiKey);
  apiSection.append(anthropicKeyField.wrapper, kiroKeyField.wrapper);

  const quickInput = document.createElement('input');
  quickInput.type = 'number';
  quickInput.className = 'chatmuse-input';
  quickInput.min = '5';
  quickInput.max = '200';
  quickInput.value = String(state.settings.quickMessageCount);

  const deepInput = document.createElement('input');
  deepInput.type = 'number';
  deepInput.className = 'chatmuse-input';
  deepInput.min = '100';
  deepInput.max = '1000';
  deepInput.value = String(state.settings.deepMessageCount);

  const debugInput = document.createElement('input');
  debugInput.type = 'checkbox';
  debugInput.checked = state.settings.debugMode;

  const promptCachingInput = document.createElement('input');
  promptCachingInput.type = 'checkbox';
  promptCachingInput.checked = state.settings.promptCachingEnabled;

  const debugLabel = document.createElement('label');
  debugLabel.style.display = 'flex';
  debugLabel.style.gap = '10px';
  debugLabel.style.alignItems = 'center';
  debugLabel.style.fontWeight = '700';
  debugLabel.append(debugInput, document.createTextNode('Enable debug mode'));

  const promptCachingLabel = document.createElement('label');
  promptCachingLabel.style.display = 'flex';
  promptCachingLabel.style.gap = '10px';
  promptCachingLabel.style.alignItems = 'center';
  promptCachingLabel.style.fontWeight = '700';
  promptCachingLabel.append(
    promptCachingInput,
    document.createTextNode('Enable prompt caching'),
  );

  apiSection.append(
    labeledField('Quick feature message count', quickInput),
    labeledField('Deep feature message count', deepInput),
    debugLabel,
    promptCachingLabel,
  );

  // ─── Provider Diagnostics ─────────────────────────────────
  const diagnosticsSection = createSection(
    'Provider Diagnostics',
    'Check effective host access, build identity, and run a live background connection test for the selected provider.',
  );
  const manifest = browser.runtime.getManifest();
  let latestProviderDiagnostics = initialProviderDiagnostics;
  let latestConnectionTest: ProviderConnectionTestResult | null = null;

  const diagnosticsCard = document.createElement('div');
  diagnosticsCard.className = 'chatmuse-card';

  const diagnosticsSummary = document.createElement('div');
  diagnosticsSummary.style.display = 'grid';
  diagnosticsSummary.style.gap = '6px';

  const diagnosticsMeta = document.createElement('div');
  diagnosticsMeta.style.display = 'grid';
  diagnosticsMeta.style.gap = '6px';
  diagnosticsMeta.style.fontSize = '13px';
  diagnosticsMeta.style.color = 'var(--chatmuse-muted)';

  const diagnosticsTestStatus = document.createElement('div');
  diagnosticsTestStatus.style.display = 'grid';
  diagnosticsTestStatus.style.gap = '4px';

  const diagnosticsActions = document.createElement('div');
  diagnosticsActions.className = 'chatmuse-card-actions';

  const testConnectionButton = createButton('Test Provider Connection');
  const openDebuggingButton = createButton('about:debugging', true);
  openDebuggingButton.addEventListener('click', () => {
    void window.open('about:debugging#/runtime/this-firefox', '_blank');
  });
  diagnosticsActions.append(testConnectionButton, openDebuggingButton);

  const reloadHint = createFieldNote(
    'If the host access check fails after a rebuild, run `npm run build`, then reload ChatMuse from about:debugging#/runtime/this-firefox.',
  );

  function updateDiagnosticsUi(
    diagnostics: ProviderDiagnostics,
    connectionTest: ProviderConnectionTestResult | null,
  ): void {
    diagnosticsSummary.replaceChildren();
    diagnosticsMeta.replaceChildren();
    diagnosticsTestStatus.replaceChildren();

    const capability = document.createElement('div');
    capability.style.fontWeight = '700';
    capability.textContent = `${diagnostics.displayName} capability: ${formatCapabilityLabel(diagnostics)}`;
    capability.style.color =
      diagnostics.capabilityStatus === 'ready'
        ? 'var(--chatmuse-success)'
        : diagnostics.capabilityStatus === 'host_access_missing'
          ? 'var(--chatmuse-danger)'
          : 'var(--chatmuse-muted)';
    diagnosticsSummary.append(capability);

    const providerLine = document.createElement('div');
    providerLine.textContent = `Provider: ${diagnostics.displayName}`;
    const requestLine = document.createElement('div');
    requestLine.textContent = `Request host: ${diagnostics.requestHost}`;
    const hostAccessLine = document.createElement('div');
    hostAccessLine.textContent = `Host access: ${diagnostics.hostPermissionGranted ? 'Granted' : 'Missing'} (${diagnostics.hostPermissionPattern})`;
    const apiKeyLine = document.createElement('div');
    apiKeyLine.textContent = `API key: ${diagnostics.hasApiKey ? 'Configured' : 'Missing'}`;
    const buildLine = document.createElement('div');
    buildLine.textContent = `Installed build: ${formatBuildTime(diagnostics.buildTime)} · v${manifest.version}`;
    diagnosticsMeta.append(
      providerLine,
      requestLine,
      hostAccessLine,
      apiKeyLine,
      buildLine,
    );

    if (connectionTest) {
      const status = document.createElement('div');
      status.style.fontWeight = '700';
      status.textContent = formatTestStatusLabel(connectionTest);
      status.style.color =
        connectionTest.status === 'ready'
          ? 'var(--chatmuse-success)'
          : connectionTest.status === 'host_access_missing' ||
              connectionTest.status === 'invalid_api_key' ||
              connectionTest.status === 'pre_response_failure'
            ? 'var(--chatmuse-danger)'
            : 'var(--chatmuse-muted)';
      const detail = document.createElement('div');
      detail.textContent = connectionTest.detail;
      detail.style.whiteSpace = 'pre-wrap';
      const checkedAt = document.createElement('div');
      checkedAt.textContent = `Checked: ${new Date(connectionTest.checkedAt).toLocaleString()}`;
      checkedAt.style.fontSize = '12px';
      checkedAt.style.color = 'var(--chatmuse-muted)';
      diagnosticsTestStatus.append(status, detail, checkedAt);
    }

    testConnectionButton.textContent = `Test ${diagnostics.displayName} Connection`;
  }

  updateDiagnosticsUi(latestProviderDiagnostics, latestConnectionTest);
  diagnosticsCard.append(
    diagnosticsSummary,
    diagnosticsMeta,
    diagnosticsActions,
    diagnosticsTestStatus,
    reloadHint,
  );
  diagnosticsSection.append(diagnosticsCard);

  // ─── AI Models ───────────────────────────────────────────
  const modelSection = createSection(
    'AI Models',
  );
  const modelSectionLead = createFieldNote('');
  modelSectionLead.style.fontSize = '14px';

  const modelChangeNote = createFieldNote('');
  modelChangeNote.style.display = 'none';
  modelChangeNote.style.color = 'var(--chatmuse-warning)';
  modelSection.append(modelSectionLead, modelChangeNote);

  const FEATURE_ROWS: Array<{ feature: FeatureType; label: string; helper: string }> = [
    { feature: 'fast-reply', label: 'Fast Reply', helper: 'Quick replies you can insert into chat.' },
    { feature: 'ping', label: 'Ping', helper: 'Reactivation messages for inactive fans.' },
    { feature: 'help-me', label: 'Help Me', helper: 'Coaching and message ideas when you get stuck.' },
    { feature: 'chat-review', label: 'Chat Review', helper: 'Deeper conversation analysis and strategy.' },
    { feature: 'fan-summary', label: 'Fan Summary', helper: 'Longer summaries of the fan relationship and context.' },
  ];

  const featureLabels = Object.fromEntries(
    FEATURE_ROWS.map(({ feature, label }) => [feature, label]),
  ) as Record<FeatureType, string>;
  const modelSelects = new Map<FeatureType, HTMLSelectElement>();
  let currentFeatureModels = {
    ...normalizeFeatureModelsForProvider(
      currentProvider,
      state.settings.featureModels,
    ).featureModels,
  };

  function refreshProviderUi(): void {
    currentProvider = normalizeClaudeProvider(providerSelect.value);
    anthropicKeyField.wrapper.style.display = currentProvider === 'anthropic' ? 'grid' : 'none';
    kiroKeyField.wrapper.style.display = currentProvider === 'kiro' ? 'grid' : 'none';
  }

  function collectFeatureModelsFromUi(): Record<FeatureType, string> {
    return Object.fromEntries(
      Array.from(modelSelects.entries()).map(([feature, select]) => [feature, select.value]),
    ) as Record<FeatureType, string>;
  }

  function refreshModelSectionLead(): void {
    modelSectionLead.textContent = `Pick which Claude model each feature uses. If you're not sure, leave everything on ${getModelLabel(getDefaultModelId(currentProvider))}.`;
  }

  function showModelChangeNote(
    provider: ClaudeProvider,
    changes: Array<{ feature: FeatureType; fromModelId: string; toModelId: string }>,
  ): void {
    if (changes.length === 0) {
      modelChangeNote.textContent = '';
      modelChangeNote.style.display = 'none';
      return;
    }

    const providerName = getClaudeProviderConfig(provider).displayName;
    if (changes.length === 1) {
      const [change] = changes;
      modelChangeNote.textContent = `${featureLabels[change.feature]} changed to ${getModelLabel(change.toModelId)} because ${getModelLabel(change.fromModelId)} is not available on ${providerName}.`;
      modelChangeNote.style.display = 'block';
      return;
    }

    modelChangeNote.textContent = `${changes.length} model selections changed to ${getModelLabel(getDefaultModelId(provider))} because their previous models are not available on ${providerName}.`;
    modelChangeNote.style.display = 'block';
  }

  function renderModelSelectOptions(
    provider: ClaudeProvider,
    featureModels: Record<FeatureType, string>,
  ): void {
    const availableModels = getModelsForProvider(provider);
    for (const [feature, select] of modelSelects.entries()) {
      select.replaceChildren();
      for (const model of availableModels) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} \u2014 ${model.description}`;
        select.append(option);
      }
      select.value = featureModels[feature];
    }
    refreshModelSectionLead();
  }

  async function refreshProviderDiagnostics(): Promise<void> {
    latestProviderDiagnostics =
      (await browser.runtime.sendMessage({ type: 'getProviderDiagnostics' })) as ProviderDiagnostics;
    updateDiagnosticsUi(latestProviderDiagnostics, latestConnectionTest);
  }

  for (const { feature, label, helper } of FEATURE_ROWS) {
    const select = document.createElement('select');
    select.className = 'chatmuse-select';
    select.dataset.feature = feature;
    modelSelects.set(feature, select);

    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gap = '4px';

    const featureLabel = document.createElement('span');
    featureLabel.textContent = label;
    featureLabel.style.fontWeight = '700';

    const helperText = document.createElement('div');
    helperText.textContent = helper;
    helperText.style.color = 'var(--chatmuse-muted)';
    helperText.style.fontSize = '13px';
    helperText.style.marginBottom = '4px';

    row.append(featureLabel, helperText, select);
    modelSection.append(row);
  }
  renderModelSelectOptions(currentProvider, currentFeatureModels);

  async function persistCurrentSettings(): Promise<void> {
    currentFeatureModels = collectFeatureModelsFromUi();

    const savedSettings = await saveSettings({
      claudeProvider: currentProvider,
      anthropicApiKey,
      kiroApiKey,
      quickMessageCount: Number(quickInput.value),
      deepMessageCount: Number(deepInput.value),
      debugMode: debugInput.checked,
      promptCachingEnabled: promptCachingInput.checked,
      featureModels: currentFeatureModels,
    });
    currentProvider = savedSettings.claudeProvider;
    anthropicApiKey = savedSettings.anthropicApiKey;
    kiroApiKey = savedSettings.kiroApiKey;
    currentFeatureModels = { ...savedSettings.featureModels };
    providerSelect.value = currentProvider;
    anthropicKeyField.input.value = anthropicApiKey;
    kiroKeyField.input.value = kiroApiKey;
    refreshProviderUi();
    renderModelSelectOptions(currentProvider, currentFeatureModels);
    latestConnectionTest = null;
    await refreshProviderDiagnostics();
  }

  const saveSettingsDebounced = debounce(() => {
    void persistCurrentSettings();
  }, 350);

  providerSelect.addEventListener('change', () => {
    refreshProviderUi();
    const normalized = normalizeFeatureModelsForProvider(
      currentProvider,
      collectFeatureModelsFromUi(),
    );
    currentFeatureModels = { ...normalized.featureModels };
    renderModelSelectOptions(currentProvider, currentFeatureModels);
    showModelChangeNote(currentProvider, normalized.changes);
    saveSettingsDebounced();
  });

  anthropicKeyField.input.addEventListener('input', () => {
    anthropicApiKey = anthropicKeyField.input.value;
    saveSettingsDebounced();
  });
  anthropicKeyField.input.addEventListener('change', () => {
    anthropicApiKey = anthropicKeyField.input.value;
    saveSettingsDebounced();
  });

  kiroKeyField.input.addEventListener('input', () => {
    kiroApiKey = kiroKeyField.input.value;
    saveSettingsDebounced();
  });
  kiroKeyField.input.addEventListener('change', () => {
    kiroApiKey = kiroKeyField.input.value;
    saveSettingsDebounced();
  });

  [quickInput, deepInput, debugInput, promptCachingInput].forEach((element) => {
    element.addEventListener('input', saveSettingsDebounced);
    element.addEventListener('change', saveSettingsDebounced);
  });
  modelSelects.forEach((select) => {
    select.addEventListener('change', saveSettingsDebounced);
  });
  testConnectionButton.addEventListener('click', async () => {
    testConnectionButton.disabled = true;
    latestConnectionTest = null;
    updateDiagnosticsUi(latestProviderDiagnostics, latestConnectionTest);

    try {
      await persistCurrentSettings();
      latestConnectionTest =
        (await browser.runtime.sendMessage({ type: 'runProviderConnectionTest' })) as ProviderConnectionTestResult;
      await refreshProviderDiagnostics();
      updateDiagnosticsUi(latestProviderDiagnostics, latestConnectionTest);
    } finally {
      testConnectionButton.disabled = false;
    }
  });
  refreshProviderUi();

  root.append(apiSection);
  root.append(diagnosticsSection);
  root.append(modelSection);

  // ─── Personalities ─────────────────────────────────────────
  const personalitiesSection = createSection('Model Personalities');
  const personalitiesList = document.createElement('div');
  personalitiesList.style.display = 'grid';
  personalitiesList.style.gap = '16px';

  const savePersonalitiesDebounced = debounce(async () => {
    const entries = Array.from(personalitiesList.querySelectorAll<HTMLElement>('[data-personality-id]')).map((card) => {
      const id = card.dataset.personalityId!;
      const nameVal = card.querySelector<HTMLInputElement>('input[data-role="name"]')!.value;
      const contentVal = card.querySelector<HTMLTextAreaElement>('textarea[data-role="content"]')!.value;
      return {
        id,
        name: nameVal,
        content: contentVal,
        updatedAt: Date.now(),
      } satisfies Personality;
    });
    await savePersonalities(entries);
    await render();
  }, 450);

  const makeCard = (personality: Personality): HTMLElement => {
    const card = document.createElement('div');
    card.dataset.personalityId = personality.id;
    card.className = 'chatmuse-card';

    const nameInput = document.createElement('input');
    nameInput.className = 'chatmuse-input';
    nameInput.dataset.role = 'name';
    nameInput.value = personality.name;

    const contentInput = document.createElement('textarea');
    contentInput.className = 'chatmuse-textarea';
    contentInput.dataset.role = 'content';
    contentInput.value = personality.content;
    contentInput.rows = 12;

    const actions = document.createElement('div');
    actions.className = 'chatmuse-card-actions';
    const deleteButton = createButton('Delete', false, true);
    deleteButton.addEventListener('click', async () => {
      const confirmed = window.confirm(`Delete personality "${nameInput.value || personality.name}"?`);
      if (!confirmed) {
        return;
      }
      await deletePersonality(personality.id);
      await render();
    });
    actions.append(deleteButton);

    nameInput.addEventListener('input', savePersonalitiesDebounced);
    contentInput.addEventListener('input', savePersonalitiesDebounced);

    card.append(labeledField('Name', nameInput), labeledField('Personality content', contentInput), actions);
    return card;
  };

  state.personalities.forEach((personality) => personalitiesList.append(makeCard(personality)));

  const addPersonality = createButton('Add Personality');
  addPersonality.addEventListener('click', async () => {
    const personalities = [
      ...state.personalities,
      {
        id: crypto.randomUUID(),
        name: 'New Personality',
        content: '',
        updatedAt: Date.now(),
      },
    ];
    await savePersonalities(personalities);
    await render();
  });

  personalitiesSection.append(personalitiesList, addPersonality);
  root.append(personalitiesSection);

  // ─── Account Mappings ──────────────────────────────────────
  const mappingsSection = createSection('Account Mappings');
  const mappingsTable = document.createElement('div');
  mappingsTable.style.display = 'grid';
  mappingsTable.style.gap = '12px';
  const personalitiesById = new Map(state.personalities.map((personality) => [personality.id, personality]));

  state.knownAccounts.forEach((accountId) => {
    const session = sessionsByAccountId.get(accountId);
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr minmax(220px, 320px) auto';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    row.style.padding = '12px';
    row.style.borderRadius = '16px';
    row.style.background = 'rgba(255,255,255,0.04)';
    row.style.border = '1px solid rgba(255,255,255,0.08)';

    const label = document.createElement('div');
    label.style.display = 'grid';
    label.style.gap = '4px';

    const labelTitle = document.createElement('div');
    labelTitle.textContent = formatAccountHeading(accountId, session);
    labelTitle.style.fontWeight = '700';

    const labelMeta = document.createElement('div');
    labelMeta.textContent = formatAccountMeta(accountId, session);
    labelMeta.style.fontSize = '12px';
    labelMeta.style.color = 'var(--chatmuse-muted)';

    label.append(labelTitle, labelMeta);

    const select = document.createElement('select');
    select.className = 'chatmuse-select';
    const unmapped = document.createElement('option');
    unmapped.value = '';
    unmapped.textContent = 'Unmapped';
    select.append(unmapped);
    for (const personality of state.personalities) {
      const option = document.createElement('option');
      option.value = personality.id;
      option.textContent = personality.name;
      select.append(option);
    }
    select.value = state.accountMappings[accountId] ?? '';
    select.addEventListener('change', async () => {
      await saveAccountMapping(accountId, select.value || null);
      await render();
    });

    const info = document.createElement('div');
    info.style.fontSize = '12px';
    info.style.color = 'var(--chatmuse-muted)';
    const mapped = personalitiesById.get(state.accountMappings[accountId] ?? '');
    info.textContent = `${mapped ? mapped.name : 'Unmapped'} \u2022 ${session?.connected ? 'Connected' : 'Disconnected'}`;

    row.append(label, select, info);
    mappingsTable.append(row);
  });

  if (state.knownAccounts.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No Fansly accounts detected yet.';
    empty.style.color = 'var(--chatmuse-muted)';
    mappingsTable.append(empty);
  }

  mappingsSection.append(mappingsTable);
  root.append(mappingsSection);

  // ─── Connection Status ─────────────────────────────────────
  const connectionsSection = createSection('Connection Status');
  const sessionsGrid = document.createElement('div');
  sessionsGrid.style.display = 'grid';
  sessionsGrid.style.gap = '10px';

  const connectionRows = buildConnectionRows(sessions);

  connectionRows
    .sort((left, right) => formatAccountHeading(left.accountId, left.session).localeCompare(formatAccountHeading(right.accountId, right.session)))
    .forEach(({ accountId, session }) => {
      const card = document.createElement('div');
      card.className = 'chatmuse-card';
      card.style.display = 'grid';
      card.style.gap = '6px';
      const heading = document.createElement('div');
      heading.style.display = 'flex';
      heading.style.justifyContent = 'space-between';
      heading.style.alignItems = 'center';
      const left = document.createElement('div');
      left.textContent = formatAccountHeading(accountId, session);
      left.style.fontWeight = '700';
      const right = document.createElement('div');
      right.textContent = session?.connected ? 'Connected' : 'Disconnected';
      right.style.color = session?.connected ? 'var(--chatmuse-success)' : 'var(--chatmuse-danger)';
      heading.append(left, right);
      const meta = document.createElement('div');
      meta.textContent = formatAccountMeta(accountId, session);
      meta.style.fontSize = '12px';
      meta.style.color = 'var(--chatmuse-muted)';
      card.append(heading, meta);
      sessionsGrid.append(card);
    });

  if (connectionRows.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No active sessions captured yet.';
    empty.style.color = 'var(--chatmuse-muted)';
    sessionsGrid.append(empty);
  }

  connectionsSection.append(sessionsGrid);
  root.append(connectionsSection);
}

injectStyles();
void render();
