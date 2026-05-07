import optionsStyles from './styles.css';
import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import { AI_MODEL_GROUPS, REASONING_EFFORTS } from '../shared/constants.js';
import {
  createUserError,
  getUserErrorDescription,
} from '../shared/errors.js';
import { supportsModelReasoningConfig } from '../shared/model-capabilities.js';
import { isOpenRouterModelSelection } from '../shared/model-registry.js';
import { saveSettings, loadStorageState, savePersonalities, saveAccountMapping, deletePersonality } from '../shared/storage.js';
import type {
  AgencyHubConnectionTestResponse,
  ModelSelectableFeatureType,
  Personality,
  ReasoningEffort,
  SessionSnapshotEntry,
  UserFacingError,
} from '../shared/types.js';

const rootElement = document.getElementById('chatgoose-options-root');
const extensionVersion = browser.runtime.getManifest().version;

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
    copy.style.color = 'var(--chatgoose-muted)';
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
  button.className = `chatgoose-button${secondary ? ' chatgoose-button-secondary' : ''}${danger ? ' chatgoose-button-danger' : ''}`;
  button.textContent = label;
  return button;
}

function createVersionTag(): HTMLDivElement {
  const tag = document.createElement('div');
  tag.className = 'chatgoose-version-tag';
  tag.textContent = `v ${extensionVersion}`;
  return tag;
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

interface AgencyHubPermissionCheckResult {
  granted: boolean;
  errorMessage: string | null;
}

type AgencyHubPermissionFeedback =
  | { kind: 'denied'; originPattern: string }
  | { kind: 'request_error'; originPattern: string; errorMessage: string }
  | { kind: 'unsupported'; originPattern: string };

type AgencyHubConnectionFeedback =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'testing' }
  | { kind: 'connected'; baseUrl: string }
  | { kind: 'failed'; error: UserFacingError };

let renderCleanup: (() => void) | null = null;
let agencyHubPermissionFeedback: AgencyHubPermissionFeedback | null = null;
let agencyHubConnectionFeedback: AgencyHubConnectionFeedback = { kind: 'idle' };

function formatAgencyHubError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message ? `${error.name}: ${message}` : error.name;
  }

  return String(error);
}

function appendAgencyHubMeta(baseText: string, note: string | null): string {
  return note ? `${baseText} ${note}` : baseText;
}

function buildAgencyHubPermissionScopeNote(baseUrl: string | null | undefined): string | null {
  const normalized = normalizeAgencyHubBaseUrl(baseUrl);
  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);
  if (!parsed.port) {
    return null;
  }

  const originPattern = buildAgencyHubOriginPattern(normalized);
  if (!originPattern) {
    return null;
  }

  return `Firefox grants host access per host rather than per port, so ${originPattern} covers the configured URL ${normalized}.`;
}

function buildAgencyHubConnectionSignature(baseUrl: string, apiKey: string): string {
  return `${normalizeAgencyHubBaseUrl(baseUrl)}|${apiKey.trim()}`;
}

function hasAgencyHubConnectionInputs(baseUrl: string, apiKey: string): boolean {
  return Boolean(baseUrl.trim() && apiKey.trim());
}

async function getAgencyHubPermissionCheck(originPattern: string | null): Promise<AgencyHubPermissionCheckResult> {
  if (!originPattern) {
    return { granted: false, errorMessage: null };
  }

  if (typeof browser.permissions?.contains !== 'function') {
    return { granted: true, errorMessage: null };
  }

  try {
    return {
      granted: await browser.permissions.contains({ origins: [originPattern] }),
      errorMessage: null,
    };
  } catch (error) {
    return {
      granted: false,
      errorMessage: formatAgencyHubError(error),
    };
  }
}

async function render(): Promise<void> {
  renderCleanup?.();
  renderCleanup = null;

  const cleanupTasks: Array<() => void> = [];
  const sessions = (await browser.runtime.sendMessage({ type: 'getSessionsSnapshot' })) as SessionSnapshotEntry[];
  const state = await loadStorageState();
  const sessionsByAccountId = buildSessionLookup(sessions);

  root.replaceChildren();
  root.style.paddingBottom = '24px';

  // ─── Hero ──────────────────────────────────────────────────
  const hero = document.createElement('div');
  hero.style.padding = '28px 20px 4px';
  hero.style.display = 'grid';
  hero.style.gap = '8px';
  hero.style.position = 'relative';
  const title = document.createElement('h1');
  title.textContent = 'ChatGoose Settings';
  title.style.margin = '0';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'Configure AI providers, personalities, mappings, and live Fansly connections.';
  subtitle.style.color = 'var(--chatgoose-muted)';
  hero.append(createVersionTag(), title, subtitle);
  root.append(hero);

  // ─── API Configuration ─────────────────────────────────────
  const apiSection = createSection('API Configuration');
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'chatgoose-input';
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

  const openRouterKeyInput = document.createElement('input');
  openRouterKeyInput.type = 'password';
  openRouterKeyInput.className = 'chatgoose-input';
  openRouterKeyInput.value = state.settings.openRouterApiKey;
  const openRouterToggle = createButton('Show', true);
  openRouterToggle.addEventListener('click', () => {
    openRouterKeyInput.type = openRouterKeyInput.type === 'password' ? 'text' : 'password';
    openRouterToggle.textContent = openRouterKeyInput.type === 'password' ? 'Show' : 'Hide';
  });
  const openRouterKeyRow = document.createElement('div');
  openRouterKeyRow.style.display = 'grid';
  openRouterKeyRow.style.gridTemplateColumns = '1fr auto';
  openRouterKeyRow.style.gap = '8px';
  openRouterKeyRow.append(openRouterKeyInput, openRouterToggle);
  apiSection.append(labeledField('OpenRouter API key', openRouterKeyRow));

  const quickInput = document.createElement('input');
  quickInput.type = 'number';
  quickInput.className = 'chatgoose-input';
  quickInput.min = '5';
  quickInput.max = '200';
  quickInput.value = String(state.settings.quickMessageCount);

  const pingInput = document.createElement('input');
  pingInput.type = 'number';
  pingInput.className = 'chatgoose-input';
  pingInput.min = '5';
  pingInput.max = '200';
  pingInput.value = String(state.settings.pingMessageCount);

  const improveInput = document.createElement('input');
  improveInput.type = 'number';
  improveInput.className = 'chatgoose-input';
  improveInput.min = '5';
  improveInput.max = '200';
  improveInput.value = String(state.settings.improveMessageCount);

  const deepInput = document.createElement('input');
  deepInput.type = 'number';
  deepInput.className = 'chatgoose-input';
  deepInput.min = '100';
  deepInput.max = '3000';
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
    labeledField('Reply + Help message count', quickInput),
    labeledField('Ping message count', pingInput),
    labeledField('Fix message count', improveInput),
    labeledField('Deep feature message count', deepInput),
    debugLabel,
    promptCachingLabel,
  );

  // ─── Agency Hub ───────────────────────────────────────────
  const agencyHubSection = createSection(
    'Agency Hub',
    'Push Fan Summary results to Agency Hub for durable storage and version history.',
  );
  const agencyHubUrlInput = document.createElement('input');
  agencyHubUrlInput.type = 'url';
  agencyHubUrlInput.className = 'chatgoose-input';
  agencyHubUrlInput.placeholder = 'http://localhost:3000';
  agencyHubUrlInput.value = state.settings.agencyHubBaseUrl;

  const agencyHubKeyInput = document.createElement('input');
  agencyHubKeyInput.type = 'password';
  agencyHubKeyInput.className = 'chatgoose-input';
  agencyHubKeyInput.value = state.settings.agencyHubApiKey;

  const agencyHubToggle = createButton('Show', true);
  agencyHubToggle.addEventListener('click', () => {
    agencyHubKeyInput.type = agencyHubKeyInput.type === 'password' ? 'text' : 'password';
    agencyHubToggle.textContent = agencyHubKeyInput.type === 'password' ? 'Show' : 'Hide';
  });

  const agencyHubKeyRow = document.createElement('div');
  agencyHubKeyRow.style.display = 'grid';
  agencyHubKeyRow.style.gridTemplateColumns = '1fr auto';
  agencyHubKeyRow.style.gap = '8px';
  agencyHubKeyRow.append(agencyHubKeyInput, agencyHubToggle);

  const agencyHubPermissionStatus = document.createElement('div');
  agencyHubPermissionStatus.style.fontWeight = '700';
  agencyHubPermissionStatus.style.fontSize = '14px';

  const agencyHubPermissionMeta = document.createElement('div');
  agencyHubPermissionMeta.style.color = 'var(--chatgoose-muted)';
  agencyHubPermissionMeta.style.fontSize = '13px';

  const agencyHubPermissionButton = createButton('Grant Access', true);
  const agencyHubConnectionStatus = document.createElement('div');
  agencyHubConnectionStatus.style.fontWeight = '700';
  agencyHubConnectionStatus.style.fontSize = '14px';

  const agencyHubConnectionMeta = document.createElement('div');
  agencyHubConnectionMeta.style.color = 'var(--chatgoose-muted)';
  agencyHubConnectionMeta.style.fontSize = '13px';

  const agencyHubConnectionButton = createButton('Test Connection', true);
  const agencyHubActionRow = document.createElement('div');
  agencyHubActionRow.style.display = 'flex';
  agencyHubActionRow.style.gap = '8px';
  agencyHubActionRow.style.flexWrap = 'wrap';
  agencyHubActionRow.append(agencyHubPermissionButton, agencyHubConnectionButton);

  let agencyHubConnectionVersion = 0;
  let lastAgencyHubConnectionSignature: string | null = null;

  const renderAgencyHubConnectionState = (): void => {
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const hasInputs = hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value);

    agencyHubConnectionButton.disabled =
      agencyHubConnectionFeedback.kind === 'testing' || !hasInputs;

    switch (agencyHubConnectionFeedback.kind) {
      case 'idle':
        agencyHubConnectionStatus.textContent = 'Not tested yet.';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-text)';
        agencyHubConnectionMeta.textContent = 'Save a Hub URL and API key to run a live connection test.';
        return;
      case 'pending':
        agencyHubConnectionStatus.textContent = 'Connection status updating…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-text)';
        agencyHubConnectionMeta.textContent = 'Saving Agency Hub changes before the next live test.';
        return;
      case 'testing':
        agencyHubConnectionStatus.textContent = 'Testing connection…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-text)';
        agencyHubConnectionMeta.textContent = 'Checking Hub reachability, permissions, and API key.';
        return;
      case 'connected':
        agencyHubConnectionStatus.textContent = 'Connected ✓';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-success)';
        agencyHubConnectionMeta.textContent = `Live connection test succeeded for ${agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || 'Agency Hub'}.`;
        return;
      case 'failed': {
        const description = getUserErrorDescription(agencyHubConnectionFeedback.error);
        agencyHubConnectionStatus.textContent = `Connection failed: ${agencyHubConnectionFeedback.error.code}`;
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-danger)';
        agencyHubConnectionMeta.textContent = description
          ? `${agencyHubConnectionFeedback.error.message} ${description}`
          : agencyHubConnectionFeedback.error.message;
        return;
      }
    }
  };

  const markAgencyHubConnectionPending = (): void => {
    agencyHubConnectionVersion += 1;
    if (!hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value)) {
      agencyHubConnectionFeedback = { kind: 'idle' };
      lastAgencyHubConnectionSignature = null;
    } else {
      agencyHubConnectionFeedback = { kind: 'pending' };
      lastAgencyHubConnectionSignature = null;
    }
    renderAgencyHubConnectionState();
  };

  const persistAgencyHubSettings = async (): Promise<void> => {
    const savedSettings = await saveSettings({
      agencyHubBaseUrl: agencyHubUrlInput.value,
      agencyHubApiKey: agencyHubKeyInput.value,
    });
    agencyHubUrlInput.value = savedSettings.agencyHubBaseUrl;
    agencyHubKeyInput.value = savedSettings.agencyHubApiKey;
  };

  const runAgencyHubConnectionTest = async (options?: {
    force?: boolean;
    saveFirst?: boolean;
  }): Promise<void> => {
    const signature = buildAgencyHubConnectionSignature(
      agencyHubUrlInput.value,
      agencyHubKeyInput.value,
    );

    if (!hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value)) {
      agencyHubConnectionFeedback = { kind: 'idle' };
      lastAgencyHubConnectionSignature = null;
      renderAgencyHubConnectionState();
      return;
    }

    if (!options?.force && signature === lastAgencyHubConnectionSignature) {
      renderAgencyHubConnectionState();
      return;
    }

    const version = ++agencyHubConnectionVersion;
    agencyHubConnectionFeedback = { kind: 'testing' };
    renderAgencyHubConnectionState();

    try {
      if (options?.saveFirst) {
        await persistAgencyHubSettings();
      }

      const response = await browser.runtime.sendMessage({
        type: 'testAgencyHubConnection',
        settings: {
          agencyHubBaseUrl: agencyHubUrlInput.value,
          agencyHubApiKey: agencyHubKeyInput.value.trim(),
        },
      }) as AgencyHubConnectionTestResponse;

      if (version !== agencyHubConnectionVersion) {
        return;
      }

      const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
      agencyHubConnectionFeedback = response.ok
        ? { kind: 'connected', baseUrl: normalizedBaseUrl }
        : {
            kind: 'failed',
            error: response.error ?? createUserError('hub_request_failed'),
          };
      lastAgencyHubConnectionSignature = buildAgencyHubConnectionSignature(
        agencyHubUrlInput.value,
        agencyHubKeyInput.value,
      );
    } catch (error) {
      console.error('Agency Hub connection test failed', error);
      if (version !== agencyHubConnectionVersion) {
        return;
      }
      agencyHubConnectionFeedback = {
        kind: 'failed',
        error: createUserError('hub_request_failed', {
          description: 'The connection test could not be completed.',
        }),
      };
      lastAgencyHubConnectionSignature = null;
    }

    renderAgencyHubConnectionState();
  };

  let agencyHubPermissionRefreshVersion = 0;
  const refreshAgencyHubPermissionState = async (): Promise<void> => {
    const refreshVersion = ++agencyHubPermissionRefreshVersion;
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const originPattern = buildAgencyHubOriginPattern(normalizedBaseUrl);
    const permissionScopeNote = buildAgencyHubPermissionScopeNote(normalizedBaseUrl);
    const hasApiKey = agencyHubKeyInput.value.trim().length > 0;
    const permissionCheck = await getAgencyHubPermissionCheck(originPattern);
    const permissionGranted = permissionCheck.granted;

    if (refreshVersion !== agencyHubPermissionRefreshVersion) {
      return;
    }

    if (permissionGranted) {
      agencyHubPermissionFeedback = null;
    }

    agencyHubPermissionButton.textContent = permissionGranted ? 'Reconnect' : 'Grant Access';
    agencyHubPermissionButton.disabled = !originPattern;

    if (!agencyHubUrlInput.value.trim()) {
      agencyHubPermissionStatus.textContent = 'Sync disabled: add an Agency Hub URL.';
      agencyHubPermissionMeta.textContent = 'Enter the Hub base URL, then grant host access for that origin.';
      return;
    }

    if (!normalizedBaseUrl) {
      agencyHubPermissionStatus.textContent = 'Sync disabled: invalid Agency Hub URL.';
      agencyHubPermissionMeta.textContent = 'Use a full http:// or https:// base URL.';
      return;
    }

    if (!permissionGranted) {
      const permissionFeedback =
        agencyHubPermissionFeedback?.originPattern === originPattern
          ? agencyHubPermissionFeedback
          : null;

      if (permissionCheck.errorMessage) {
        agencyHubPermissionStatus.textContent = 'Sync disabled: host access could not be verified.';
        agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
          `Firefox returned an error while checking ${originPattern}: ${permissionCheck.errorMessage}.`,
          permissionScopeNote,
        );
        return;
      }

      if (permissionFeedback) {
        switch (permissionFeedback.kind) {
          case 'denied':
            agencyHubPermissionStatus.textContent = 'Sync disabled: host access not granted.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              `Firefox did not grant access for ${originPattern}. Click Grant Access to try again.`,
              permissionScopeNote,
            );
            return;
          case 'request_error':
            agencyHubPermissionStatus.textContent = 'Sync disabled: failed to request host access.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              `Firefox returned an error while requesting ${originPattern}: ${permissionFeedback.errorMessage}.`,
              permissionScopeNote,
            );
            return;
          case 'unsupported':
            agencyHubPermissionStatus.textContent = 'Sync disabled: host permission requests unavailable.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              'This browser build does not expose browser.permissions.request for Agency Hub access.',
              permissionScopeNote,
            );
            return;
        }
      }

      if (typeof browser.permissions?.request !== 'function') {
        agencyHubPermissionStatus.textContent = 'Sync disabled: host permission requests unavailable.';
        agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
          'This browser build does not expose browser.permissions.request for Agency Hub access.',
          permissionScopeNote,
        );
        return;
      }

      agencyHubPermissionStatus.textContent = 'Sync disabled: host access not granted.';
      agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
        `Grant access for ${originPattern} before ChatGoose can push summaries.`,
        permissionScopeNote,
      );
      return;
    }

    if (!hasApiKey) {
      agencyHubPermissionStatus.textContent = 'Sync disabled: Agency Hub API key missing.';
      agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
        `Host access is granted for ${originPattern}, but ChatGoose still needs an Agency Hub API key.`,
        permissionScopeNote,
      );
      return;
    }

    agencyHubPermissionStatus.textContent = 'Sync ready: ChatGoose can push fan summaries.';
    agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
      `Host access granted for ${originPattern}.`,
      permissionScopeNote,
    );
  };

  agencyHubPermissionButton.addEventListener('click', () => {
    const settingsPatch = {
      agencyHubBaseUrl: normalizeAgencyHubBaseUrl(agencyHubUrlInput.value),
      agencyHubApiKey: agencyHubKeyInput.value.trim(),
    };
    const originPattern = buildAgencyHubOriginPattern(settingsPatch.agencyHubBaseUrl);

    agencyHubPermissionButton.disabled = true;

    if (!originPattern) {
      void refreshAgencyHubPermissionState();
      return;
    }

    let permissionRequestPromise: Promise<boolean> | null = null;
    if (typeof browser.permissions?.request === 'function') {
      try {
        permissionRequestPromise = browser.permissions.request({ origins: [originPattern] });
      } catch (error) {
        console.error('Agency Hub permission request failed', error);
        agencyHubPermissionFeedback = {
          kind: 'request_error',
          originPattern,
          errorMessage: formatAgencyHubError(error),
        };
      }
    } else {
      agencyHubPermissionFeedback = { kind: 'unsupported', originPattern };
    }

    void (async () => {
      try {
        if (permissionRequestPromise) {
          try {
            const permissionGranted = await permissionRequestPromise;
            agencyHubPermissionFeedback = permissionGranted
              ? null
              : { kind: 'denied', originPattern };
          } catch (error) {
            console.error('Agency Hub permission request failed', error);
            agencyHubPermissionFeedback = {
              kind: 'request_error',
              originPattern,
              errorMessage: formatAgencyHubError(error),
            };
          }
        }

        try {
          const savedSettings = await saveSettings(settingsPatch);
          agencyHubUrlInput.value = savedSettings.agencyHubBaseUrl;
          agencyHubKeyInput.value = savedSettings.agencyHubApiKey;
        } catch (error) {
          console.error('Failed to save Agency Hub settings', error);
        }
      } finally {
        await refreshAgencyHubPermissionState();
        await runAgencyHubConnectionTest({ force: true });
      }
    })();
  });

  agencyHubConnectionButton.addEventListener('click', () => {
    void (async () => {
      try {
        await persistAgencyHubSettings();
      } catch (error) {
        console.error('Failed to save Agency Hub settings', error);
      }
      await refreshAgencyHubPermissionState();
      await runAgencyHubConnectionTest({ force: true });
    })();
  });

  agencyHubSection.append(
    labeledField('Agency Hub base URL', agencyHubUrlInput),
    labeledField('Agency Hub API key', agencyHubKeyRow),
    agencyHubPermissionStatus,
    agencyHubPermissionMeta,
    agencyHubConnectionStatus,
    agencyHubConnectionMeta,
    agencyHubActionRow,
  );

  // ─── AI Models ───────────────────────────────────────────
  const modelSection = createSection(
    'AI Models',
    'Pick which AI model each feature uses. Claude models use the Anthropic key; Gemini and Grok use the OpenRouter key.',
  );

  const FEATURE_ROWS: Array<{ feature: ModelSelectableFeatureType; label: string; helper: string }> = [
    { feature: 'fast-reply', label: 'Fast Reply', helper: 'Quick replies you can insert into chat.' },
    { feature: 'ping', label: 'Ping', helper: 'Reactivation messages for inactive fans.' },
    { feature: 'help-me', label: 'Help Me', helper: 'Coaching and message ideas when you get stuck.' },
    { feature: 'chat-review', label: 'Chat Review', helper: 'Deeper conversation analysis and strategy.' },
    { feature: 'fan-summary', label: 'Fan Summary', helper: 'Longer summaries of the fan relationship and context.' },
  ];

  const REASONING_LABELS: Record<ReasoningEffort, string> = {
    off: 'Off',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
  };

  const modelSelects: HTMLSelectElement[] = [];
  const reasoningSelects: HTMLSelectElement[] = [];
  const reasoningSelectsByFeature = new Map<ModelSelectableFeatureType, HTMLSelectElement>();
  const openRouterWarning = document.createElement('div');
  openRouterWarning.style.padding = '10px 12px';
  openRouterWarning.style.borderRadius = '12px';
  openRouterWarning.style.border = '1px solid rgba(245, 158, 11, 0.35)';
  openRouterWarning.style.background = 'rgba(245, 158, 11, 0.12)';
  openRouterWarning.style.color = 'var(--chatgoose-warning, #fbbf24)';
  openRouterWarning.style.fontWeight = '700';
  openRouterWarning.style.fontSize = '13px';

  const renderOpenRouterWarning = (): void => {
    const usesOpenRouter = modelSelects.some((select) =>
      isOpenRouterModelSelection(select.value),
    );
    const missingKey = !openRouterKeyInput.value.trim();
    openRouterWarning.textContent =
      usesOpenRouter && missingKey
        ? 'OpenRouter model selected: add an OpenRouter API key before using those features.'
        : '';
    openRouterWarning.style.display = usesOpenRouter && missingKey ? 'block' : 'none';
  };

  for (const { feature, label, helper } of FEATURE_ROWS) {
    const select = document.createElement('select');
    select.className = 'chatgoose-select';
    select.dataset.feature = feature;

    for (const group of AI_MODEL_GROUPS) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const model of group.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} \u2014 ${model.description}`;
        if (model.pricingNote) {
          option.title = model.pricingNote;
        }
        optgroup.append(option);
      }
      select.append(optgroup);
    }

    select.value = state.settings.featureModels[feature];
    modelSelects.push(select);

    const reasoningSelect = document.createElement('select');
    reasoningSelect.className = 'chatgoose-select';
    reasoningSelect.dataset.reasoningFeature = feature;
    for (const effort of REASONING_EFFORTS) {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = REASONING_LABELS[effort];
      reasoningSelect.append(option);
    }
    reasoningSelect.value = state.settings.featureReasoning[feature];
    reasoningSelects.push(reasoningSelect);
    reasoningSelectsByFeature.set(feature, reasoningSelect);

    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gap = '4px';

    const featureLabel = document.createElement('span');
    featureLabel.textContent = label;
    featureLabel.style.fontWeight = '700';

    const helperText = document.createElement('div');
    helperText.textContent = helper;
    helperText.style.color = 'var(--chatgoose-muted)';
    helperText.style.fontSize = '13px';
    helperText.style.marginBottom = '4px';

    const controls = document.createElement('div');
    controls.className = 'chatgoose-model-config-grid';
    controls.append(
      labeledField('Model', select),
      labeledField('Reasoning', reasoningSelect),
    );

    row.append(featureLabel, helperText, controls);
    modelSection.append(row);
  }

  const updateReasoningCapability = (
    feature: ModelSelectableFeatureType,
    modelId: string,
  ): void => {
    const reasoningSelect = reasoningSelectsByFeature.get(feature);
    if (!reasoningSelect) {
      return;
    }

    const supported = supportsModelReasoningConfig(modelId, feature);
    reasoningSelect.disabled = !supported;
    reasoningSelect.dataset.reasoningSupported = supported ? 'true' : 'false';
    reasoningSelect.setAttribute('aria-disabled', supported ? 'false' : 'true');
    reasoningSelect.title = supported
      ? ''
      : 'Reasoning is not supported for this selected model and feature.';
  };

  for (const select of modelSelects) {
    updateReasoningCapability(
      select.dataset.feature as ModelSelectableFeatureType,
      select.value,
    );
  }
  renderOpenRouterWarning();
  modelSection.append(openRouterWarning);

  const saveSettingsDebounced = debounce(async () => {
    const featureModels: Record<string, string> = {};
    for (const sel of modelSelects) {
      featureModels[sel.dataset.feature!] = sel.value;
    }
    const featureReasoning: Record<string, ReasoningEffort> = {};
    for (const sel of reasoningSelects) {
      featureReasoning[sel.dataset.reasoningFeature!] = sel.value as ReasoningEffort;
    }

    const savedSettings = await saveSettings({
      claudeApiKey: keyInput.value,
      openRouterApiKey: openRouterKeyInput.value,
      agencyHubBaseUrl: agencyHubUrlInput.value,
      agencyHubApiKey: agencyHubKeyInput.value,
      quickMessageCount: Number(quickInput.value),
      pingMessageCount: Number(pingInput.value),
      improveMessageCount: Number(improveInput.value),
      deepMessageCount: Number(deepInput.value),
      debugMode: debugInput.checked,
      promptCachingEnabled: promptCachingInput.checked,
      featureModels: featureModels as Record<ModelSelectableFeatureType, string>,
      featureReasoning: featureReasoning as Record<ModelSelectableFeatureType, ReasoningEffort>,
    });

    keyInput.value = savedSettings.claudeApiKey;
    openRouterKeyInput.value = savedSettings.openRouterApiKey;
    agencyHubUrlInput.value = savedSettings.agencyHubBaseUrl;
    agencyHubKeyInput.value = savedSettings.agencyHubApiKey;

    const hubSignature = buildAgencyHubConnectionSignature(
      savedSettings.agencyHubBaseUrl,
      savedSettings.agencyHubApiKey,
    );
    if (hubSignature !== lastAgencyHubConnectionSignature) {
      await refreshAgencyHubPermissionState();
      await runAgencyHubConnectionTest({ force: true });
    }
  }, 350);

  [
    keyInput,
    openRouterKeyInput,
    agencyHubUrlInput,
    agencyHubKeyInput,
    quickInput,
    pingInput,
    improveInput,
    deepInput,
    debugInput,
    promptCachingInput,
  ].forEach((element) => {
    element.addEventListener('input', saveSettingsDebounced);
    element.addEventListener('change', saveSettingsDebounced);
  });
  openRouterKeyInput.addEventListener('input', renderOpenRouterWarning);
  openRouterKeyInput.addEventListener('change', renderOpenRouterWarning);
  for (const select of reasoningSelects) {
    select.addEventListener('input', saveSettingsDebounced);
    select.addEventListener('change', saveSettingsDebounced);
  }
  agencyHubUrlInput.addEventListener('input', () => {
    markAgencyHubConnectionPending();
    void refreshAgencyHubPermissionState();
  });
  agencyHubUrlInput.addEventListener('change', () => {
    markAgencyHubConnectionPending();
    void refreshAgencyHubPermissionState();
  });
  agencyHubKeyInput.addEventListener('input', () => {
    markAgencyHubConnectionPending();
    void refreshAgencyHubPermissionState();
  });
  agencyHubKeyInput.addEventListener('change', () => {
    markAgencyHubConnectionPending();
    void refreshAgencyHubPermissionState();
  });
  if (
    typeof browser.permissions?.onAdded?.addListener === 'function' &&
    typeof browser.permissions?.onAdded?.removeListener === 'function' &&
    typeof browser.permissions?.onRemoved?.addListener === 'function' &&
    typeof browser.permissions?.onRemoved?.removeListener === 'function'
  ) {
    const handlePermissionChanged = () => {
      agencyHubPermissionFeedback = null;
      void (async () => {
        await refreshAgencyHubPermissionState();
        await runAgencyHubConnectionTest({ force: true });
      })();
    };

    browser.permissions.onAdded.addListener(handlePermissionChanged);
    browser.permissions.onRemoved.addListener(handlePermissionChanged);
    cleanupTasks.push(() => {
      browser.permissions.onAdded.removeListener(handlePermissionChanged);
      browser.permissions.onRemoved.removeListener(handlePermissionChanged);
    });
  }
  modelSelects.forEach((select) => {
    select.addEventListener('change', () => {
      updateReasoningCapability(
        select.dataset.feature as ModelSelectableFeatureType,
        select.value,
      );
      renderOpenRouterWarning();
      void saveSettingsDebounced();
    });
  });

  root.append(apiSection);
  root.append(agencyHubSection);
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
      const builtin = card.dataset.personalityBuiltin === 'true';
      const builtinVersion = Number(card.dataset.personalityBuiltinVersion);
      return {
        id,
        name: nameVal,
        content: contentVal,
        updatedAt: Date.now(),
        ...(builtin ? { builtin: true } : {}),
        ...(builtin && Number.isFinite(builtinVersion) ? { builtinVersion } : {}),
      } satisfies Personality;
    });
    await savePersonalities(entries);
    await render();
  }, 450);

  const makeCard = (personality: Personality): HTMLElement => {
    const card = document.createElement('div');
    card.dataset.personalityId = personality.id;
    card.dataset.personalityBuiltin = personality.builtin ? 'true' : 'false';
    if (personality.builtinVersion !== undefined) {
      card.dataset.personalityBuiltinVersion = String(personality.builtinVersion);
    }
    card.className = 'chatgoose-card';

    const nameInput = document.createElement('input');
    nameInput.className = 'chatgoose-input';
    nameInput.dataset.role = 'name';
    nameInput.value = personality.name;

    const contentInput = document.createElement('textarea');
    contentInput.className = 'chatgoose-textarea';
    contentInput.dataset.role = 'content';
    contentInput.value = personality.content;
    contentInput.rows = 12;

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';
    if (!personality.builtin) {
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
    }

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
    labelMeta.style.color = 'var(--chatgoose-muted)';

    label.append(labelTitle, labelMeta);

    const select = document.createElement('select');
    select.className = 'chatgoose-select';
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
    info.style.color = 'var(--chatgoose-muted)';
    const mapped = personalitiesById.get(state.accountMappings[accountId] ?? '');
    info.textContent = `${mapped ? mapped.name : 'Unmapped'} \u2022 ${session?.connected ? 'Connected' : 'Disconnected'}`;

    row.append(label, select, info);
    mappingsTable.append(row);
  });

  if (state.knownAccounts.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No Fansly accounts detected yet.';
    empty.style.color = 'var(--chatgoose-muted)';
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
      card.className = 'chatgoose-card';
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
      right.style.color = session?.connected ? 'var(--chatgoose-success)' : 'var(--chatgoose-danger)';
      heading.append(left, right);
      const meta = document.createElement('div');
      meta.textContent = formatAccountMeta(accountId, session);
      meta.style.fontSize = '12px';
      meta.style.color = 'var(--chatgoose-muted)';
      card.append(heading, meta);
      sessionsGrid.append(card);
    });

  if (connectionRows.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No active sessions captured yet.';
    empty.style.color = 'var(--chatgoose-muted)';
    sessionsGrid.append(empty);
  }

  connectionsSection.append(sessionsGrid);
  root.append(connectionsSection);

  renderCleanup = () => {
    cleanupTasks.forEach((cleanup) => cleanup());
    renderCleanup = null;
  };

  await refreshAgencyHubPermissionState();
  await runAgencyHubConnectionTest({ force: true });
}

injectStyles();
void render();
