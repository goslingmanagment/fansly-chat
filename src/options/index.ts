import optionsStyles from './styles.css';
import {
  appendAgencyHubMeta,
  buildAgencyHubConnectionSignature,
  buildAgencyHubPermissionScopeNote,
  formatAgencyHubError,
  getAgencyHubPermissionCheck,
  hasAgencyHubConnectionInputs,
  type AgencyHubConnectionFeedback,
  type AgencyHubPermissionFeedback,
} from './agency-hub-settings.js';
import {
  createButton,
  createSection,
  createVersionTag,
  debounce,
  injectStyles,
  labeledField,
} from './dom.js';
import {
  buildConnectionRows,
  buildSessionLookup,
  formatAccountHeading,
  formatAccountMeta,
} from './sessions.js';
import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import {
  createUserError,
  getUserErrorDescription,
} from '../shared/errors.js';
import { sendRuntimeRequest } from '../shared/protocol.js';
import { saveSettings, loadStorageState, savePersonalities, saveAccountMapping, deletePersonality } from '../shared/storage.js';
import { installUiTheme } from '../shared/theme.js';
import type {
  Personality,
  UiThemeSetting,
} from '../shared/types.js';

const rootElement = document.getElementById('chatgoose-options-root');
const extensionVersion = browser.runtime.getManifest().version;

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing options root');
}

const root = rootElement;

let renderCleanup: (() => void) | null = null;
let agencyHubPermissionFeedback: AgencyHubPermissionFeedback | null = null;
let agencyHubConnectionFeedback: AgencyHubConnectionFeedback = { kind: 'idle' };
let uiThemeInstalled = false;

async function render(): Promise<void> {
  renderCleanup?.();
  renderCleanup = null;

  const cleanupTasks: Array<() => void> = [];
  const sessions = await sendRuntimeRequest('getSessionsSnapshot');
  const state = await loadStorageState();
  const sessionsByAccountId = buildSessionLookup(sessions);

  // One-time: reuse this render's state instead of a second storage read;
  // installUiTheme keeps itself current afterwards (storage + OS listeners).
  if (!uiThemeInstalled) {
    uiThemeInstalled = true;
    installUiTheme(state.settings.uiTheme);
  }

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
  subtitle.textContent = 'Configure generation, Agency Hub sync, personalities, mappings, and live Fansly connections.';
  subtitle.style.color = 'var(--chatgoose-ink-mid)';
  hero.append(createVersionTag(extensionVersion), title, subtitle);
  root.append(hero);

  // ─── Appearance ─────────────────────────────────────────────
  const appearanceSection = createSection(
    'Appearance',
    'One family look, light and dark. System follows your OS.',
  );
  const themeSelect = document.createElement('select');
  themeSelect.className = 'chatgoose-select';
  const themeChoices: Array<{ value: UiThemeSetting; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  for (const choice of themeChoices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    themeSelect.append(option);
  }
  themeSelect.value = state.settings.uiTheme;
  themeSelect.addEventListener('change', () => {
    // installUiTheme's storage listener re-applies the theme on save.
    void saveSettings({ uiTheme: themeSelect.value as UiThemeSetting });
  });
  appearanceSection.append(labeledField('Theme', themeSelect));

  // ─── Generation settings (Stage 32: keys/models are kernel-side) ────
  const apiSection = createSection('Generation');

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

  const debugLabel = document.createElement('label');
  debugLabel.style.display = 'flex';
  debugLabel.style.gap = '10px';
  debugLabel.style.alignItems = 'center';
  debugLabel.style.fontWeight = '600';
  debugLabel.append(debugInput, document.createTextNode('Enable debug mode'));

  apiSection.append(
    labeledField('Reply + Help message count', quickInput),
    labeledField('Ping message count', pingInput),
    labeledField('Fix message count', improveInput),
    labeledField('Deep feature message count', deepInput),
    debugLabel,
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
  agencyHubKeyInput.autocomplete = 'off';
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
  agencyHubPermissionStatus.style.fontWeight = '600';
  agencyHubPermissionStatus.style.fontSize = '14px';

  const agencyHubPermissionMeta = document.createElement('div');
  agencyHubPermissionMeta.style.color = 'var(--chatgoose-ink-mid)';
  agencyHubPermissionMeta.style.fontSize = '13px';

  const agencyHubPermissionButton = createButton('Grant Access', true);
  const agencyHubConnectionStatus = document.createElement('div');
  agencyHubConnectionStatus.style.fontWeight = '600';
  agencyHubConnectionStatus.style.fontSize = '14px';

  const agencyHubConnectionMeta = document.createElement('div');
  agencyHubConnectionMeta.style.color = 'var(--chatgoose-ink-mid)';
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
    const hasInputs = hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken);

    agencyHubConnectionButton.disabled =
      agencyHubConnectionFeedback.kind === 'testing' || !hasInputs;

    switch (agencyHubConnectionFeedback.kind) {
      case 'idle':
        agencyHubConnectionStatus.textContent = 'Not tested yet.';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Save a Hub URL and API key to run a live connection test.';
        return;
      case 'pending':
        agencyHubConnectionStatus.textContent = 'Connection status updating…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Saving Agency Hub changes before the next live test.';
        return;
      case 'testing':
        agencyHubConnectionStatus.textContent = 'Testing connection…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Checking Hub reachability, permissions, and API key.';
        return;
      case 'connected':
        agencyHubConnectionStatus.textContent = 'Connected ✓';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-green)';
        agencyHubConnectionMeta.textContent = `Live connection test succeeded for ${agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || 'Agency Hub'}.`;
        return;
      case 'failed': {
        const failedError = agencyHubConnectionFeedback.error;
        const description = getUserErrorDescription(failedError);
        agencyHubConnectionStatus.textContent = `Connection failed: ${failedError.code}`;
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-bad)';
        const serverEcho = typeof failedError.httpStatus === 'number'
          ? `Hub responded ${failedError.httpStatus}${failedError.serverDetail ? `: ${failedError.serverDetail}` : ''}`
          : null;
        agencyHubConnectionMeta.textContent = [
          failedError.message,
          description,
          serverEcho,
        ].filter(Boolean).join(' ');
        return;
      }
    }
  };

  const markAgencyHubConnectionPending = (): void => {
    agencyHubConnectionVersion += 1;
    if (!hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken)) {
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
      state.settings.agencyHubDeviceToken,
    );

    if (!hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken)) {
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

      const response = await sendRuntimeRequest('testAgencyHubConnection', {
        settings: {
          agencyHubBaseUrl: agencyHubUrlInput.value,
          agencyHubApiKey: agencyHubKeyInput.value.trim(),
          agencyHubDeviceToken: state.settings.agencyHubDeviceToken,
        },
      });

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
        state.settings.agencyHubDeviceToken,
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
    const hasApiKey = agencyHubKeyInput.value.trim().length > 0 || state.settings.agencyHubDeviceToken.trim().length > 0;
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
      agencyHubPermissionStatus.textContent = 'Sync disabled: Agency Hub credential missing.';
      agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
        `Host access is granted for ${originPattern}, but ChatGoose still needs a credential — sign in or add the hub key.`,
        permissionScopeNote,
      );
      return;
    }

    // Never claim readiness here: this is a local check (permission + a
    // non-empty credential) — only the live connection test below proves sync.
    agencyHubPermissionStatus.textContent = 'Host access granted.';
    agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
      `ChatGoose can reach ${originPattern}. Sync goes live once the connection test below passes.`,
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

  // ── Stage 32: one-time device-token sign-in (preferred over the key) ──
  const hubSignInUserInput = document.createElement('input');
  hubSignInUserInput.type = 'text';
  hubSignInUserInput.autocomplete = 'username';
  hubSignInUserInput.className = 'chatgoose-input';
  hubSignInUserInput.placeholder = 'Hub username';

  const hubSignInPasswordInput = document.createElement('input');
  hubSignInPasswordInput.type = 'password';
  hubSignInPasswordInput.autocomplete = 'current-password';
  hubSignInPasswordInput.className = 'chatgoose-input';
  hubSignInPasswordInput.placeholder = 'Hub password';

  const hubSignInButton = createButton('Sign in & issue device token', true);
  const hubSignInStatus = document.createElement('div');
  hubSignInStatus.style.fontWeight = '600';
  hubSignInStatus.style.fontSize = '14px';
  const hubSignInMeta = document.createElement('div');
  hubSignInMeta.style.color = 'var(--chatgoose-ink-mid)';
  hubSignInMeta.style.fontSize = '13px';

  const renderHubSignInState = (): void => {
    const hasToken = Boolean(state.settings.agencyHubDeviceToken.trim());
    hubSignInStatus.textContent = hasToken
      ? 'Device token active ✓'
      : 'No device token yet.';
    hubSignInStatus.style.color = hasToken
      ? 'var(--chatgoose-green)'
      : 'var(--chatgoose-ink)';
    if (!hubSignInMeta.textContent) {
      hubSignInMeta.textContent = hasToken
        ? 'Hub requests use the device token; the legacy API key is the fallback.'
        : 'Sign in once to issue a device-bound token — no more pasting an issued key, and it survives key rotation.';
    }
  };

  hubSignInButton.addEventListener('click', () => {
    void (async () => {
      const username = hubSignInUserInput.value.trim();
      const password = hubSignInPasswordInput.value;
      if (!username || !password || !agencyHubUrlInput.value.trim()) {
        hubSignInMeta.textContent = 'Enter the Hub base URL, username, and password first.';
        return;
      }
      hubSignInButton.disabled = true;
      hubSignInMeta.textContent = 'Signing in…';
      try {
        const response = await sendRuntimeRequest('issueAgencyHubDeviceToken', {
          baseUrl: agencyHubUrlInput.value,
          username,
          password,
        });
        if (response.ok) {
          // Re-read the real stored settings — the background deliberately
          // returns only metadata; a placeholder here would later be SENT as
          // the bearer by the connection test (1.7.0 audit finding).
          state.settings = (await loadStorageState()).settings;
          hubSignInPasswordInput.value = '';
          hubSignInMeta.textContent =
            `Device token ${response.keyPrefix}… issued (expires ${new Date(response.expiresAt).toLocaleDateString()}).`;
        } else {
          hubSignInMeta.textContent = `Sign-in failed: ${response.error.message}`;
        }
      } finally {
        hubSignInButton.disabled = false;
        renderHubSignInState();
      }
    })();
  });
  renderHubSignInState();

  const hubSignInRow = document.createElement('div');
  hubSignInRow.style.display = 'flex';
  hubSignInRow.style.gap = '8px';
  hubSignInRow.style.flexWrap = 'wrap';
  hubSignInRow.append(hubSignInUserInput, hubSignInPasswordInput, hubSignInButton);

  agencyHubSection.append(
    labeledField('Agency Hub base URL', agencyHubUrlInput),
    labeledField('Sign in (device token)', hubSignInRow),
    hubSignInStatus,
    hubSignInMeta,
    labeledField('Agency Hub API key (legacy fallback)', agencyHubKeyRow),
    agencyHubPermissionStatus,
    agencyHubPermissionMeta,
    agencyHubConnectionStatus,
    agencyHubConnectionMeta,
    agencyHubActionRow,
  );

  // ─── AI Models ───────────────────────────────────────────

  const saveSettingsDebounced = debounce(async () => {
    const savedSettings = await saveSettings({
      agencyHubBaseUrl: agencyHubUrlInput.value,
      agencyHubApiKey: agencyHubKeyInput.value,
      quickMessageCount: Number(quickInput.value),
      pingMessageCount: Number(pingInput.value),
      improveMessageCount: Number(improveInput.value),
      deepMessageCount: Number(deepInput.value),
      debugMode: debugInput.checked,
    });

    agencyHubUrlInput.value = savedSettings.agencyHubBaseUrl;
    agencyHubKeyInput.value = savedSettings.agencyHubApiKey;

    // Reflect the sanitized/clamped counts back into the fields so an
    // out-of-range or blank entry doesn't keep displaying a value that differs
    // from what was stored. Skip a field the user is still editing.
    const writeCount = (input: HTMLInputElement, value: number): void => {
      if (document.activeElement !== input) {
        input.value = String(value);
      }
    };
    writeCount(quickInput, savedSettings.quickMessageCount);
    writeCount(pingInput, savedSettings.pingMessageCount);
    writeCount(improveInput, savedSettings.improveMessageCount);
    writeCount(deepInput, savedSettings.deepMessageCount);

    const hubSignature = buildAgencyHubConnectionSignature(
      savedSettings.agencyHubBaseUrl,
      savedSettings.agencyHubApiKey,
      savedSettings.agencyHubDeviceToken,
    );
    if (hubSignature !== lastAgencyHubConnectionSignature) {
      await refreshAgencyHubPermissionState();
      await runAgencyHubConnectionTest({ force: true });
    }
  }, 350);

  [
    agencyHubUrlInput,
    agencyHubKeyInput,
    quickInput,
    pingInput,
    improveInput,
    deepInput,
    debugInput,
  ].forEach((element) => {
    element.addEventListener('input', saveSettingsDebounced);
    element.addEventListener('change', saveSettingsDebounced);
  });
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
  root.append(appearanceSection);
  root.append(apiSection);
  root.append(agencyHubSection);

  // ─── Personalities ─────────────────────────────────────────
  const personalitiesSection = createSection('Model Personalities');
  const personalitiesList = document.createElement('div');
  personalitiesList.style.display = 'grid';
  personalitiesList.style.gap = '16px';

  const collectPersonalityEntries = (): Personality[] =>
    Array.from(personalitiesList.querySelectorAll<HTMLElement>('[data-personality-id]')).map((card) => {
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

  const savePersonalitiesDebounced = debounce(async () => {
    // Persist without re-rendering: rebuilding the DOM here would replace the
    // textarea the user is editing and steal focus/caret mid-edit. Keep the
    // in-memory state in sync so add/delete read current values.
    state.personalities = await savePersonalities(collectPersonalityEntries());
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

    // W9.2/A7 (E17): built-in personas are read-only — the kernel owns the
    // builtin voice, and a local edit was silently ignored at generation time
    // (the kernel assembles from ITS builtin:lora, not from this textarea).
    // Locking the card ends that silent drift; custom personas sync instead.
    if (personality.builtin) {
      nameInput.readOnly = true;
      contentInput.readOnly = true;
      nameInput.title = 'Built-in personality — read-only';
      contentInput.title = 'Built-in personality — read-only. Add a personality to customize a voice.';
    }

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';
    if (personality.builtin) {
      const builtinNote = document.createElement('div');
      builtinNote.textContent = 'Built-in personality — read-only. Add a personality to customize a voice.';
      builtinNote.style.fontSize = '12px';
      builtinNote.style.color = 'var(--chatgoose-ink-mid)';
      actions.append(builtinNote);
    }
    if (!personality.builtin) {
      const deleteButton = createButton('Delete', false, true);
      deleteButton.addEventListener('click', async () => {
        const confirmed = window.confirm(`Delete personality "${nameInput.value || personality.name}"?`);
        if (!confirmed) {
          return;
        }
        // Cancel the pending debounced save so a stale pre-delete snapshot can't
        // flush afterwards and resurrect this card, then flush current edits so
        // other cards' in-progress changes survive the delete (which also clears
        // this personality's account mappings and cached summaries).
        savePersonalitiesDebounced.cancel();
        await savePersonalities(collectPersonalityEntries());
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
    // Cancel the pending debounced save and read current DOM values so an
    // in-progress edit isn't lost when the list is rebuilt.
    savePersonalitiesDebounced.cancel();
    const personalities = [
      ...collectPersonalityEntries(),
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
  // Names aren't unique; track collisions so the mapping dropdown can
  // disambiguate same-named personalities with a short id suffix.
  const personalityNameCounts = new Map<string, number>();
  for (const personality of state.personalities) {
    personalityNameCounts.set(personality.name, (personalityNameCounts.get(personality.name) ?? 0) + 1);
  }
  const personalityOptionLabel = (personality: Personality): string =>
    (personalityNameCounts.get(personality.name) ?? 0) > 1
      ? `${personality.name} · ${personality.id.slice(0, 6)}`
      : personality.name;

  state.knownAccounts.forEach((accountId) => {
    const session = sessionsByAccountId.get(accountId);
    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr minmax(220px, 320px) auto';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    row.style.padding = '12px';
    row.style.borderRadius = 'var(--chatgoose-radius-card)';
    row.style.background = 'var(--chatgoose-bg2)';
    row.style.border = '1px solid var(--chatgoose-line)';

    const label = document.createElement('div');
    label.style.display = 'grid';
    label.style.gap = '4px';

    const labelTitle = document.createElement('div');
    labelTitle.textContent = formatAccountHeading(accountId, session);
    labelTitle.style.fontWeight = '600';

    const labelMeta = document.createElement('div');
    labelMeta.textContent = formatAccountMeta(accountId, session);
    labelMeta.style.fontSize = '12px';
    labelMeta.style.color = 'var(--chatgoose-ink-mid)';

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
      option.textContent = personalityOptionLabel(personality);
      select.append(option);
    }
    select.value = state.accountMappings[accountId] ?? '';
    select.addEventListener('change', async () => {
      await saveAccountMapping(accountId, select.value || null);
      await render();
    });

    const info = document.createElement('div');
    info.style.fontSize = '12px';
    info.style.color = 'var(--chatgoose-ink-mid)';
    const mapped = personalitiesById.get(state.accountMappings[accountId] ?? '');
    info.textContent = `${mapped ? personalityOptionLabel(mapped) : 'Unmapped'} \u2022 ${session?.connected ? 'Connected' : 'Disconnected'}`;

    row.append(label, select, info);
    mappingsTable.append(row);
  });

  if (state.knownAccounts.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No Fansly accounts detected yet.';
    empty.style.color = 'var(--chatgoose-ink-mid)';
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
      left.style.fontWeight = '600';
      const right = document.createElement('div');
      right.textContent = session?.connected ? 'Connected' : 'Disconnected';
      right.style.color = session?.connected ? 'var(--chatgoose-green)' : 'var(--chatgoose-bad)';
      heading.append(left, right);
      const meta = document.createElement('div');
      meta.textContent = formatAccountMeta(accountId, session);
      meta.style.fontSize = '12px';
      meta.style.color = 'var(--chatgoose-ink-mid)';
      card.append(heading, meta);
      sessionsGrid.append(card);
    });

  if (connectionRows.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No active sessions captured yet.';
    empty.style.color = 'var(--chatgoose-ink-mid)';
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

injectStyles(optionsStyles);
void render();
