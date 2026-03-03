import optionsStyles from './styles.css';
import { CLAUDE_MODELS } from '../shared/constants.js';
import { saveSettings, loadStorageState, savePersonalities, saveAccountMapping, deletePersonality } from '../shared/storage.js';
import type { FeatureType, Personality, SessionSnapshotEntry } from '../shared/types.js';

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

async function render(): Promise<void> {
  const state = await loadStorageState();
  const sessions = (await browser.runtime.sendMessage({ type: 'getSessionsSnapshot' })) as SessionSnapshotEntry[];
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
  subtitle.textContent = 'Configure Claude, personalities, mappings, and live Fansly connections.';
  subtitle.style.color = 'var(--chatmuse-muted)';
  hero.append(title, subtitle);
  root.append(hero);

  // ─── API Configuration ─────────────────────────────────────
  const apiSection = createSection('API Configuration');
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'chatmuse-input';
  keyInput.value = state.settings.claudeApiKey;
  const toggle = createButton('Show', true);
  toggle.addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    toggle.textContent = keyInput.type === 'password' ? 'Show' : 'Hide';
  });
  const keyRow = document.createElement('div');
  keyRow.style.display = 'grid';
  keyRow.style.gridTemplateColumns = '1fr auto';
  keyRow.style.gap = '8px';
  keyRow.append(keyInput, toggle);
  apiSection.append(labeledField('Claude API key', keyRow));

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

  const debugLabel = document.createElement('label');
  debugLabel.style.display = 'flex';
  debugLabel.style.gap = '10px';
  debugLabel.style.alignItems = 'center';
  debugLabel.style.fontWeight = '700';
  debugLabel.append(debugInput, document.createTextNode('Enable debug mode'));

  apiSection.append(
    labeledField('Quick feature message count', quickInput),
    labeledField('Deep feature message count', deepInput),
    debugLabel,
  );

  // ─── AI Models ───────────────────────────────────────────
  const modelSection = createSection(
    'AI Models',
    'Pick which Claude model each feature uses. If you\'re not sure, leave everything on Claude Sonnet 4.6.',
  );

  const FEATURE_ROWS: Array<{ feature: FeatureType; label: string; helper: string }> = [
    { feature: 'fast-reply', label: 'Fast Reply', helper: 'Quick replies you can insert into chat.' },
    { feature: 'ping', label: 'Ping', helper: 'Reactivation messages for inactive fans.' },
    { feature: 'help-me', label: 'Help Me', helper: 'Coaching and message ideas when you get stuck.' },
    { feature: 'chat-review', label: 'Chat Review', helper: 'Deeper conversation analysis and strategy.' },
    { feature: 'fan-summary', label: 'Fan Summary', helper: 'Longer summaries of the fan relationship and context.' },
  ];

  const modelSelects: HTMLSelectElement[] = [];

  for (const { feature, label, helper } of FEATURE_ROWS) {
    const select = document.createElement('select');
    select.className = 'chatmuse-select';
    select.dataset.feature = feature;

    for (const model of CLAUDE_MODELS) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.label} \u2014 ${model.description}`;
      select.append(option);
    }

    select.value = state.settings.featureModels[feature];
    modelSelects.push(select);

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

  const saveSettingsDebounced = debounce(async () => {
    const featureModels: Record<string, string> = {};
    for (const sel of modelSelects) {
      featureModels[sel.dataset.feature!] = sel.value;
    }

    await saveSettings({
      claudeApiKey: keyInput.value,
      quickMessageCount: Number(quickInput.value),
      deepMessageCount: Number(deepInput.value),
      debugMode: debugInput.checked,
      featureModels: featureModels as Record<FeatureType, string>,
    });
  }, 350);

  [keyInput, quickInput, deepInput, debugInput].forEach((element) => {
    element.addEventListener('input', saveSettingsDebounced);
    element.addEventListener('change', saveSettingsDebounced);
  });
  modelSelects.forEach((select) => {
    select.addEventListener('change', saveSettingsDebounced);
  });

  root.append(apiSection);
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

  const connectionRows = new Map<string, { accountId: string; session: SessionSnapshotEntry | null }>();

  state.knownAccounts.forEach((accountId) => {
    const session = sessionsByAccountId.get(accountId) ?? null;
    const canonicalAccountId = session?.resolvedAccountId ?? session?.legacyAccountId ?? accountId;
    connectionRows.set(canonicalAccountId, { accountId: canonicalAccountId, session });
  });

  sessions.forEach((session) => {
    const canonicalAccountId = session.resolvedAccountId ?? session.legacyAccountId;
    connectionRows.set(canonicalAccountId, { accountId: canonicalAccountId, session });
  });

  Array.from(connectionRows.values())
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

  if (connectionRows.size === 0) {
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
