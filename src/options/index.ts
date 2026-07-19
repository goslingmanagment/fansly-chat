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
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  COACH_HISTORY_LIMIT_MAX,
  COACH_HISTORY_LIMIT_MIN,
  DEEP_MAX_MESSAGE_COUNT,
  DEEP_MIN_MESSAGE_COUNT,
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
  PERSONA_CATALOG_SOURCE_STORAGE_KEY,
  PERSONA_CATALOG_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../shared/constants.js';
import {
  buildLegacyPersonaExport,
  ensureLegacyPersonaSnapshot,
  InvalidLegacyPersonaSnapshotError,
} from '../shared/persona-preservation.js';
import { sendRuntimeRequest } from '../shared/protocol.js';
import {
  loadStorageState,
  readStorageState,
  saveAccountMapping,
  saveSettings,
} from '../shared/storage.js';
import { installUiTheme } from '../shared/theme.js';
import type {
  PersonaCatalogEntry,
  SessionSnapshotEntry,
  Settings,
  UiThemeSetting,
} from '../shared/types.js';

const rootElement = document.getElementById('chatgoose-options-root');
const extensionVersion = browser.runtime.getManifest().version;

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing options root');
}

const root = rootElement;

let renderCleanup: (() => Promise<void>) | null = null;
let agencyHubPermissionFeedback: AgencyHubPermissionFeedback | null = null;
let agencyHubConnectionFeedback: AgencyHubConnectionFeedback = { kind: 'idle' };
let uiThemeInstalled = false;

function createLegacyPersonaExportControls(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const exportStatus = document.createElement('div');
  exportStatus.setAttribute('role', 'status');
  exportStatus.setAttribute('aria-live', 'polite');
  exportStatus.style.fontSize = '12px';
  exportStatus.style.color = 'var(--chatgoose-ink-mid)';
  const exportJson = async (): Promise<string> => JSON.stringify(
    await buildLegacyPersonaExport(),
    null,
    2,
  );
  const downloadExport = createButton('Download legacy persona JSON', true);
  downloadExport.addEventListener('click', () => {
    downloadExport.disabled = true;
    void exportJson().then((json) => {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `chatgoose-legacy-personas-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      exportStatus.textContent = 'Legacy persona JSON downloaded.';
    }).catch((error: unknown) => {
      console.error('Failed to export legacy persona data', error);
      exportStatus.textContent = 'Export failed. Reload Settings and try again.';
    }).finally(() => {
      downloadExport.disabled = false;
    });
  });
  const copyExport = createButton('Copy legacy persona JSON', true);
  copyExport.addEventListener('click', () => {
    copyExport.disabled = true;
    void exportJson().then(async (json) => {
      await navigator.clipboard.writeText(json);
      exportStatus.textContent = 'Legacy persona JSON copied.';
    }).catch((error: unknown) => {
      console.error('Failed to copy legacy persona data', error);
      exportStatus.textContent = 'Copy failed. Use Download instead.';
    }).finally(() => {
      copyExport.disabled = false;
    });
  });
  const exportActions = document.createElement('div');
  exportActions.className = 'chatgoose-card-actions';
  exportActions.append(downloadExport, copyExport);
  fragment.append(exportActions, exportStatus);
  return fragment;
}

function renderLegacyPersonaRecovery(): void {
  root.replaceChildren();
  root.style.paddingBottom = '24px';
  const hero = document.createElement('div');
  hero.style.padding = '28px 20px 4px';
  hero.style.display = 'grid';
  hero.style.gap = '8px';
  const title = document.createElement('h1');
  title.textContent = 'ChatGoose Persona Recovery';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'The preserved legacy persona snapshot is malformed. Normal Settings and Agency Hub access are disabled so the snapshot cannot be overwritten.';
  subtitle.style.color = 'var(--chatgoose-ink-mid)';
  hero.append(createVersionTag(extensionVersion), title, subtitle);

  const recovery = createSection(
    'Legacy Persona Recovery',
    'Export the malformed preserved value together with the current legacy persona data, mappings, and aliases for manual recovery.',
  );
  recovery.append(createLegacyPersonaExportControls());
  root.append(hero, recovery);
}

async function render(): Promise<void> {
  await renderCleanup?.();
  renderCleanup = null;

  const cleanupTasks: Array<() => void> = [];
  let disposed = false;
  let futureSchemaObserved: number | null = null;
  let applyFutureSchemaBarrierToUi: ((storedVersion: number) => void) | null = null;
  try {
    // Recovery must be decided before session discovery or a Hub connection
    // test can trigger network traffic. The malformed value remains untouched.
    await ensureLegacyPersonaSnapshot();
  } catch (error) {
    if (error instanceof InvalidLegacyPersonaSnapshotError) {
      renderLegacyPersonaRecovery();
      return;
    }
    throw error;
  }
  // Install the schema observer before the first Settings state snapshot. A
  // future-version commit therefore lands either in that snapshot or in this
  // listener; there is no read->listener gap where a v14 page could miss v15
  // and later serialize its stale form during pagehide.
  if (
    typeof browser.storage.onChanged?.addListener === 'function' &&
    typeof browser.storage.onChanged?.removeListener === 'function'
  ) {
    const handleFutureSchemaChange = (
      changes: Record<string, browser.storage.StorageChange>,
      areaName: string,
    ): void => {
      const storedVersion = Number(changes.schemaVersion?.newValue);
      if (
        areaName !== 'local' ||
        !Number.isSafeInteger(storedVersion) ||
        storedVersion <= STORAGE_SCHEMA_VERSION
      ) {
        return;
      }
      futureSchemaObserved = Math.max(futureSchemaObserved ?? 0, storedVersion);
      applyFutureSchemaBarrierToUi?.(futureSchemaObserved);
    };
    browser.storage.onChanged.addListener(handleFutureSchemaChange);
    cleanupTasks.push(() => {
      browser.storage.onChanged.removeListener(handleFutureSchemaChange);
    });
  }
  // Start live session discovery immediately, but do not put it on the
  // critical path for the local settings UI. getSessionsSnapshot may spend up
  // to five seconds resolving a Fansly identity. It also owns identity
  // rekey/reconcile, so account controls stay in a loading state until it has
  // finished and we have re-read the resulting storage state.
  const sessionsResultPromise = sendRuntimeRequest('getSessionsSnapshot')
    .then((sessions):
      | { ok: true; sessions: SessionSnapshotEntry[] }
      | { ok: false; error: unknown } => (
      Array.isArray(sessions)
        ? { ok: true, sessions }
        : { ok: false, error: new Error('Invalid sessions snapshot response') }
    ))
    .catch((error: unknown): { ok: false; error: unknown } => ({ ok: false, error }));
  // This first read must stay non-mutating. Session discovery owns account
  // identity reconciliation and runs concurrently; a full-state migration
  // write from an older snapshot could otherwise restore pre-rekey mappings.
  const state = await readStorageState();

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
  subtitle.textContent = 'Configure generation, Agency Hub, persona mappings, and live Fansly connections.';
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

  const coachHistoryInput = document.createElement('input');
  coachHistoryInput.type = 'number';
  coachHistoryInput.className = 'chatgoose-input';
  coachHistoryInput.min = String(COACH_HISTORY_LIMIT_MIN);
  coachHistoryInput.max = String(COACH_HISTORY_LIMIT_MAX);
  // Turn count is an integer — step=1 keeps the browser's number spinner and
  // validity check on whole turns (sanitizeSettings rounds regardless).
  coachHistoryInput.step = '1';
  coachHistoryInput.value = String(state.settings.coachHistoryLimit);

  const coachRecapSelect = document.createElement('select');
  coachRecapSelect.className = 'chatgoose-select';
  const coachRecapChoices: Array<{ value: Settings['coachAutoRecap']; label: string }> = [
    { value: 'off', label: 'Off' },
    { value: 'short', label: 'Short' },
    { value: 'full', label: 'Full' },
  ];
  for (const choice of coachRecapChoices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    coachRecapSelect.append(option);
  }
  coachRecapSelect.value = state.settings.coachAutoRecap;

  // Full Recap replays the whole deep window before coaching — surface the cost
  // so it's a deliberate choice, not a surprise on the bill.
  const coachRecapWarning = document.createElement('div');
  coachRecapWarning.className = 'chatgoose-section-desc';
  // Text is built from the LIVE deep-window value, never a hardcoded 3000, so it
  // stays truthful when the chatter changes "Deep feature message count" (or the
  // stored value is clamped on save). Falls back to the loaded setting while the
  // field holds a blank/non-numeric mid-edit value.
  const updateCoachRecapWarning = (): void => {
    const rawDeep = Number(deepInput.value);
    const parsedDeep =
      Number.isFinite(rawDeep) && rawDeep > 0
        ? Math.round(rawDeep)
        : state.settings.deepMessageCount;
    // Clamp to the same [min, max] sanitizeSettings persists, so the warning can
    // never quote an unreachable count (typing 99999 must read 3000, not 99999 —
    // an honest cost warning, E43). The debounced save reflects the clamp too, but
    // only after a round-trip; this clamps live while the chatter is reading it.
    const shownDeep = Math.min(
      DEEP_MAX_MESSAGE_COUNT,
      Math.max(DEEP_MIN_MESSAGE_COUNT, parsedDeep),
    );
    coachRecapWarning.textContent =
      `Full Recap loads up to ${shownDeep} messages — slow and expensive.`;
    coachRecapWarning.hidden = coachRecapSelect.value !== 'full';
  };
  updateCoachRecapWarning();

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
    labeledField('Coach dialog memory (exchanges)', coachHistoryInput),
    labeledField('Auto-Recap before coaching', coachRecapSelect),
    coachRecapWarning,
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

  // Assigned after the shared settings writer is built below. Every Hub action
  // uses that same writer so a direct Test/Grant save cannot race a debounced
  // theme/count edit through a second read-modify-write path.
  let persistAgencyHubSettings: () => Promise<void> = async () => undefined;

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
          await persistAgencyHubSettings();
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
        // Finish the shared local form write before the background issues a
        // device token from those Hub inputs. This prevents a delayed local
        // settings write from restoring the pre-sign-in base URL afterwards.
        await persistAgencyHubSettings();
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

  let agencyHubApiKeyDirty = false;
  const settingsFormSignature = (): string => JSON.stringify([
    themeSelect.value,
    agencyHubUrlInput.value,
    agencyHubKeyInput.value,
    quickInput.value,
    pingInput.value,
    improveInput.value,
    deepInput.value,
    coachHistoryInput.value,
    coachRecapSelect.value,
    debugInput.checked,
  ]);
  const collectSettingsPatch = (forceHubSnapshot = false): Partial<Settings> => {
    const patch: Partial<Settings> = {
      uiTheme: themeSelect.value as UiThemeSetting,
      agencyHubBaseUrl: agencyHubUrlInput.value,
      quickMessageCount: Number(quickInput.value),
      pingMessageCount: Number(pingInput.value),
      improveMessageCount: Number(improveInput.value),
      deepMessageCount: Number(deepInput.value),
      coachHistoryLimit: Number(coachHistoryInput.value),
      coachAutoRecap: coachRecapSelect.value as Settings['coachAutoRecap'],
      debugMode: debugInput.checked,
    };
    // The API key has its own custody key. A theme/count save from a stale
    // Options tab must not write the old visible value over a rotation made by
    // another tab or the background. Only an explicit edit owns this field.
    if (
      agencyHubApiKeyDirty ||
      (forceHubSnapshot && agencyHubKeyInput.value !== state.settings.agencyHubApiKey)
    ) {
      patch.agencyHubApiKey = agencyHubKeyInput.value;
    }
    return patch;
  };

  const mergeSavedFormSettings = (
    savedSettings: Settings,
    patch: Partial<Settings>,
  ): Settings => ({
    ...savedSettings,
    // Device tokens are background-issued and never form-owned. Preserve a
    // newer sign-in/re-read if an older local write acknowledges afterwards.
    agencyHubDeviceToken: state.settings.agencyHubDeviceToken,
    // Likewise, a patch that did not explicitly own the custody key must not
    // make this page's in-memory view regress to its stale base snapshot.
    agencyHubApiKey: Object.prototype.hasOwnProperty.call(patch, 'agencyHubApiKey')
      ? savedSettings.agencyHubApiKey
      : state.settings.agencyHubApiKey,
  });

  let settingsSaveChain: Promise<void> | null = null;
  let settingsDirty = false;
  let settingsSnapshotVersion = 0;
  let agencyHubApiKeySnapshotVersion = 0;
  let settingsSaveChainSignature: string | null = null;
  const queueSettingsSave = (forceHubSnapshot = false): Promise<void> => {
    if (futureSchemaObserved !== null) {
      settingsDirty = false;
      return Promise.resolve();
    }
    // Capture the fields now, then serialize storage writes. A slow previous
    // storage read must not be allowed to finish after a newer edit and put an
    // older form snapshot back into storage.
    const formSignature = settingsFormSignature();
    const patch = collectSettingsPatch(forceHubSnapshot);
    const snapshotVersion = ++settingsSnapshotVersion;
    if (Object.prototype.hasOwnProperty.call(patch, 'agencyHubApiKey')) {
      agencyHubApiKeySnapshotVersion = snapshotVersion;
    }
    settingsDirty = false;
    const persist = async (): Promise<void> => {
      // A snapshot may have waited behind an older write. Recheck the live
      // observer when the serialized chain actually reaches it.
      if (futureSchemaObserved !== null) {
        return;
      }
      const savedSettings = await saveSettings(patch, state.settings, {
        observedSchemaVersion: futureSchemaObserved ?? state.schemaVersion,
      });
      if (
        Object.prototype.hasOwnProperty.call(patch, 'agencyHubApiKey') &&
        snapshotVersion === agencyHubApiKeySnapshotVersion &&
        agencyHubKeyInput.value === patch.agencyHubApiKey
      ) {
        // A newer non-credential snapshot may already exist, but it is queued
        // behind this one and needs the successfully-written custody value as
        // its base. Move only the field this snapshot explicitly owned.
        agencyHubApiKeyDirty = false;
        state.settings = {
          ...state.settings,
          agencyHubApiKey: savedSettings.agencyHubApiKey,
        };
      }
      const mergedSettings = mergeSavedFormSettings(savedSettings, patch);
      if (snapshotVersion !== settingsSnapshotVersion) {
        return;
      }
      state.settings = mergedSettings;

      if (disposed) {
        return;
      }

      agencyHubUrlInput.value = mergedSettings.agencyHubBaseUrl;
      if (!agencyHubApiKeyDirty && document.activeElement !== agencyHubKeyInput) {
        agencyHubKeyInput.value = mergedSettings.agencyHubApiKey;
      }

      // Reflect the sanitized/clamped counts back into the fields so an
      // out-of-range or blank entry doesn't keep displaying a value that differs
      // from what was stored. Skip a field the user is still editing.
      const writeCount = (input: HTMLInputElement, value: number): void => {
        if (document.activeElement !== input) {
          input.value = String(value);
        }
      };
      writeCount(quickInput, mergedSettings.quickMessageCount);
      writeCount(pingInput, mergedSettings.pingMessageCount);
      writeCount(improveInput, mergedSettings.improveMessageCount);
      writeCount(deepInput, mergedSettings.deepMessageCount);
      // The reflected/clamped deep count feeds the Full Recap cost warning.
      updateCoachRecapWarning();
      writeCount(coachHistoryInput, mergedSettings.coachHistoryLimit);
      if (document.activeElement !== coachRecapSelect) {
        coachRecapSelect.value = mergedSettings.coachAutoRecap;
        updateCoachRecapWarning();
      }

      const hubSignature = buildAgencyHubConnectionSignature(
        mergedSettings.agencyHubBaseUrl,
        mergedSettings.agencyHubApiKey,
        mergedSettings.agencyHubDeviceToken,
      );
      if (hubSignature !== lastAgencyHubConnectionSignature) {
        // Connection diagnostics can take much longer than local persistence.
        // Keep them outside the serialized write chain so a second edit (or a
        // pagehide flush) never waits behind a network check before storage.
        void (async () => {
          await refreshAgencyHubPermissionState();
          if (!disposed) {
            await runAgencyHubConnectionTest({ force: true });
          }
        })().catch((error: unknown) => {
          console.error('Failed to refresh Agency Hub status after Settings save', error);
        });
      }
    };
    const execution = settingsSaveChain
      ? settingsSaveChain.then(persist)
      : persist();
    const settled = execution
      .catch((error: unknown) => {
        console.error('Failed to save Settings changes', error);
      });
    settingsSaveChain = settled;
    settingsSaveChainSignature = formSignature;
    void settled.finally(() => {
      if (settingsSaveChain === settled) {
        settingsSaveChain = null;
        settingsSaveChainSignature = null;
      }
    });
    return settled;
  };

  const saveSettingsDebounced = debounce(queueSettingsSave, 350);
  const scheduleSettingsSave = (): void => {
    if (futureSchemaObserved !== null) return;
    settingsDirty = true;
    saveSettingsDebounced();
  };
  const flushSettingsSave = (): Promise<void> => {
    const flushed = saveSettingsDebounced.flush();
    return flushed ?? settingsSaveChain ?? Promise.resolve();
  };
  persistAgencyHubSettings = (): Promise<void> => {
    const currentSignature = settingsFormSignature();
    if (
      settingsSaveChain !== null &&
      settingsSaveChainSignature === currentSignature
    ) {
      // A blur/change may have scheduled the exact snapshot a Hub action needs.
      // Join it instead of writing the same form twice.
      saveSettingsDebounced.cancel();
      settingsDirty = false;
      return settingsSaveChain;
    }

    // Hub actions are explicit persistence boundaries. They must save even
    // when values were assigned programmatically (no input/change event), or
    // when the current form differs from the active queued snapshot.
    saveSettingsDebounced.cancel();
    return queueSettingsSave(true);
  };

  // Toggle the cost warning the moment the picker changes, ahead of any save,
  // and keep its message tracking the deep-window field as the chatter types.
  coachRecapSelect.addEventListener('change', updateCoachRecapWarning);
  deepInput.addEventListener('input', updateCoachRecapWarning);

  [
    themeSelect,
    agencyHubUrlInput,
    agencyHubKeyInput,
    quickInput,
    pingInput,
    improveInput,
    deepInput,
    coachHistoryInput,
    coachRecapSelect,
    debugInput,
  ].forEach((element) => {
    element.addEventListener('input', () => {
      if (element === agencyHubKeyInput) {
        agencyHubApiKeyDirty = true;
      }
      scheduleSettingsSave();
    });
    element.addEventListener('change', () => {
      if (element === agencyHubKeyInput) {
        agencyHubApiKeyDirty = true;
      }
      scheduleSettingsSave();
      void saveSettingsDebounced.flush();
    });
    element.addEventListener('blur', () => {
      void saveSettingsDebounced.flush();
    });
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

  // ─── Persona catalog (server-owned, metadata only) ─────────
  const personalitiesSection = createSection(
    'Model Personalities',
    'Global personalities are managed by Agency Hub admins. This extension only reads the catalog and stores account mappings.',
  );
  const personalitiesList = document.createElement('div');
  personalitiesList.style.display = 'grid';
  personalitiesList.style.gap = '10px';
  let refreshAccountMappingPersonalityOptions: (() => void) | null = null;

  const renderPersonaCatalog = (): void => {
    personalitiesList.replaceChildren();
    if (state.personaCatalog.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No server personas are available yet. Check the Agency Hub connection or ask an admin to create one.';
      empty.style.color = 'var(--chatgoose-ink-mid)';
      personalitiesList.append(empty);
      return;
    }
    for (const persona of state.personaCatalog) {
      const card = document.createElement('div');
      card.className = 'chatgoose-card';
      card.dataset.personaKey = persona.key;
      const heading = document.createElement('div');
      heading.textContent = persona.displayName;
      heading.style.fontWeight = '700';
      const meta = document.createElement('div');
      meta.textContent = `${persona.key} • version ${persona.version} • ${persona.status}`;
      meta.style.fontSize = '12px';
      meta.style.color = persona.status === 'active'
        ? 'var(--chatgoose-ink-mid)'
        : 'var(--chatgoose-bad)';
      card.append(heading, meta);
      personalitiesList.append(card);
    }
  };
  renderPersonaCatalog();

  const preservationNote = document.createElement('div');
  preservationNote.textContent = 'Legacy local persona text is preserved unchanged on this device. Export it before removing the extension or clearing browser data.';
  preservationNote.style.color = 'var(--chatgoose-ink-mid)';
  preservationNote.style.fontSize = '13px';

  const flushPendingEdits = (): Promise<void> => {
    void flushSettingsSave();
    return (settingsSaveChain ?? Promise.resolve()).then(() => undefined);
  };
  const handlePageHide = (): void => {
    // pagehide cannot wait for an existing save chain. Cancel pending timers
    // and invoke storage.set for the newest dirty snapshots NOW, even when an
    // older write promise is still unsettled. Calls are issued oldest->newest,
    // preserving storage.local's last-write-wins order without scheduling the
    // same snapshot through the normal chain a second time.
    saveSettingsDebounced.cancel();
    if (futureSchemaObserved !== null) {
      settingsDirty = false;
      agencyHubApiKeyDirty = false;
      return;
    }
    if (settingsDirty || agencyHubApiKeyDirty) {
      settingsDirty = false;
      const patch = collectSettingsPatch();
      const snapshotVersion = ++settingsSnapshotVersion;
      if (Object.prototype.hasOwnProperty.call(patch, 'agencyHubApiKey')) {
        agencyHubApiKeySnapshotVersion = snapshotVersion;
      }
      void saveSettings(patch, state.settings, {
        observedSchemaVersion: futureSchemaObserved ?? state.schemaVersion,
      })
        .then((savedSettings) => {
          if (
            Object.prototype.hasOwnProperty.call(patch, 'agencyHubApiKey') &&
            snapshotVersion === agencyHubApiKeySnapshotVersion &&
            agencyHubKeyInput.value === patch.agencyHubApiKey
          ) {
            agencyHubApiKeyDirty = false;
            state.settings = {
              ...state.settings,
              agencyHubApiKey: savedSettings.agencyHubApiKey,
            };
          }
          if (snapshotVersion === settingsSnapshotVersion) {
            state.settings = mergeSavedFormSettings(savedSettings, patch);
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to save Settings changes on pagehide', error);
        });
    }
  };
  window.addEventListener('pagehide', handlePageHide);
  cleanupTasks.push(() => window.removeEventListener('pagehide', handlePageHide));

  personalitiesSection.append(
    personalitiesList,
    preservationNote,
    createLegacyPersonaExportControls(),
  );
  root.append(personalitiesSection);

  // ─── Account Mappings ──────────────────────────────────────
  const mappingsSection = createSection('Account Mappings');
  mappingsSection.dataset.sessionHydration = 'loading';
  const mappingsTable = document.createElement('div');
  mappingsTable.style.display = 'grid';
  mappingsTable.style.gap = '12px';
  const mappingsLoading = document.createElement('div');
  mappingsLoading.textContent = 'Loading Fansly accounts…';
  mappingsLoading.style.color = 'var(--chatgoose-ink-mid)';
  mappingsTable.append(mappingsLoading);
  mappingsSection.append(mappingsTable);
  root.append(mappingsSection);

  // ─── Connection Status ─────────────────────────────────────
  const connectionsSection = createSection('Connection Status');
  connectionsSection.dataset.sessionHydration = 'loading';
  const sessionsGrid = document.createElement('div');
  sessionsGrid.style.display = 'grid';
  sessionsGrid.style.gap = '10px';
  const connectionsLoading = document.createElement('div');
  connectionsLoading.textContent = 'Loading live connection status…';
  connectionsLoading.style.color = 'var(--chatgoose-ink-mid)';
  sessionsGrid.append(connectionsLoading);
  connectionsSection.append(sessionsGrid);
  root.append(connectionsSection);

  cleanupTasks.push(() => {
    disposed = true;
  });

  type PersonalityMappingView = {
    personality: PersonaCatalogEntry;
    label: string;
    usable: boolean;
  };
  const buildPersonalityMappingViews = (): PersonalityMappingView[] => {
    const personalityNameCounts = new Map<string, number>();
    for (const personality of state.personaCatalog) {
      personalityNameCounts.set(
        personality.displayName,
        (personalityNameCounts.get(personality.displayName) ?? 0) + 1,
      );
    }
    return state.personaCatalog.map((personality) => {
      const label = (personalityNameCounts.get(personality.displayName) ?? 0) > 1
        ? `${personality.displayName} · ${personality.key.slice(0, 6)}`
        : personality.displayName;
      return {
        personality,
        label,
        usable: personality.status === 'active',
      };
    });
  };
  const populateMappingSelect = (
    select: HTMLSelectElement,
    selectedPersonalityId: string,
    views: PersonalityMappingView[],
  ): { label: string; usable: boolean } | null => {
    const unmapped = document.createElement('option');
    unmapped.value = '';
    unmapped.textContent = 'Unmapped';
    select.replaceChildren(unmapped);
    for (const view of views) {
      const option = document.createElement('option');
      option.value = view.personality.key;
      option.textContent = view.usable
        ? view.label
        : `${view.label} · archived`;
      option.disabled = !view.usable;
      select.append(option);
    }

    const selectedView = views.find(
      (view) => view.personality.key === selectedPersonalityId,
    ) ?? null;
    if (selectedPersonalityId && !selectedView) {
      const missing = document.createElement('option');
      missing.value = selectedPersonalityId;
      missing.textContent = `Unavailable persona · ${selectedPersonalityId}`;
      missing.disabled = true;
      select.append(missing);
      select.value = selectedPersonalityId;
      return { label: missing.textContent, usable: false };
    }
    select.value = selectedView?.personality.key ?? '';
    return selectedView
      ? { label: selectedView.label, usable: selectedView.usable }
      : null;
  };

  refreshAccountMappingPersonalityOptions = (): void => {
    if (disposed || mappingsSection.dataset.sessionHydration === 'loading') {
      return;
    }
    const views = buildPersonalityMappingViews();
    for (const select of mappingsTable.querySelectorAll<HTMLSelectElement>(
      'select[data-account-id]',
    )) {
      const accountId = select.dataset.accountId!;
      const selectedPersonalityId = select.dataset.mappingPending === 'true'
        ? select.value
        : (state.accountMappings[accountId] ?? '');
      const selectedView = populateMappingSelect(select, selectedPersonalityId, views);
      const info = select.closest<HTMLElement>('[data-account-mapping-row]')
        ?.querySelector<HTMLElement>('[data-role="mapping-info"]');
      if (info) {
        info.textContent = `${selectedView?.label ?? 'Unmapped'}${selectedView && !selectedView.usable ? ' · unavailable' : ''} • ${select.dataset.connected === 'true' ? 'Connected' : 'Disconnected'}`;
      }
    }
  };

  if (
    typeof browser.storage.onChanged?.addListener === 'function' &&
    typeof browser.storage.onChanged?.removeListener === 'function'
  ) {
    let catalogReadGeneration = 0;
    const activateFutureSchemaBarrier = (storedVersion: number): void => {
      futureSchemaObserved = Math.max(futureSchemaObserved ?? 0, storedVersion);
      if (root.querySelector('[data-future-schema-barrier="true"]')) return;
      settingsDirty = false;
      agencyHubApiKeyDirty = false;
      settingsSnapshotVersion += 1;
      agencyHubApiKeySnapshotVersion = settingsSnapshotVersion;
      saveSettingsDebounced.cancel();
      for (const control of root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement
      >('input, select, button, textarea')) {
        control.disabled = true;
      }
      const warning = document.createElement('div');
      warning.dataset.futureSchemaBarrier = 'true';
      warning.setAttribute('role', 'alert');
      warning.textContent = `Settings were upgraded by a newer ChatGoose build (storage v${storedVersion}). Reload this page before editing.`;
      warning.style.margin = '16px 20px 0';
      warning.style.padding = '12px';
      warning.style.border = '1px solid var(--chatgoose-bad)';
      warning.style.borderRadius = 'var(--chatgoose-radius-card)';
      warning.style.color = 'var(--chatgoose-bad)';
      root.prepend(warning);
    };
    applyFutureSchemaBarrierToUi = activateFutureSchemaBarrier;
    if (futureSchemaObserved !== null) {
      activateFutureSchemaBarrier(futureSchemaObserved);
    }
    const handleCatalogStorageChange = (
      changes: Record<string, browser.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (
        areaName !== 'local' ||
        !(
          changes.settings ||
          changes[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] ||
          changes[AGENCY_HUB_API_KEY_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_SOURCE_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]
        )
      ) {
        return;
      }
      const generation = ++catalogReadGeneration;
      void readStorageState().then((refreshedState) => {
        if (disposed || generation !== catalogReadGeneration) {
          return;
        }
        state.personaCatalog = refreshedState.personaCatalog;
        state.personaCatalogSource = refreshedState.personaCatalogSource;
        state.personaCatalogFetchedAt = refreshedState.personaCatalogFetchedAt;
        renderPersonaCatalog();
        refreshAccountMappingPersonalityOptions?.();
      }).catch((error: unknown) => {
        console.error('Failed to apply live persona catalog update', error);
      });
    };
    browser.storage.onChanged.addListener(handleCatalogStorageChange);
    cleanupTasks.push(() => {
      catalogReadGeneration += 1;
      applyFutureSchemaBarrierToUi = null;
      browser.storage.onChanged.removeListener(handleCatalogStorageChange);
    });
  }

  const renderAccountMappings = (
    sessions: SessionSnapshotEntry[],
    hydrationFailed: boolean,
  ): void => {
    const sessionsByAccountId = buildSessionLookup(sessions);
    const personalityViews = buildPersonalityMappingViews();

    mappingsTable.replaceChildren();
    mappingsSection.dataset.sessionHydration = hydrationFailed ? 'failed' : 'ready';

    if (hydrationFailed) {
      const warning = document.createElement('div');
      warning.textContent = 'Live account refresh failed. Showing mappings from local storage.';
      warning.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(warning);
    }

    state.knownAccounts.forEach((accountId) => {
      const session = sessionsByAccountId.get(accountId);
      const row = document.createElement('div');
      row.dataset.accountMappingRow = accountId;
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
      select.dataset.accountId = accountId;
      select.dataset.connected = session?.connected ? 'true' : 'false';
      const mappedView = populateMappingSelect(
        select,
        state.accountMappings[accountId] ?? '',
        personalityViews,
      );
      select.addEventListener('change', () => {
        const selectedPersonalityId = select.value || null;
        select.disabled = true;
        select.dataset.mappingPending = 'true';
        void (async () => {
          try {
            await saveAccountMapping(accountId, selectedPersonalityId);
            const refreshedState = await loadStorageState();
            if (disposed) {
              return;
            }
            state.accountMappings = refreshedState.accountMappings;
            state.accountAliases = refreshedState.accountAliases;
            state.knownAccounts = refreshedState.knownAccounts;
            // Update only the account rows. Rebuilding the whole page here
            // would replace personality inputs and could flush stale debounced
            // form state over a user's in-progress edit.
            renderAccountMappings(sessions, hydrationFailed);
          } catch (error) {
            console.error('Failed to save account mapping', error);
            if (!disposed) {
              select.dataset.mappingPending = 'false';
              select.disabled = false;
              refreshAccountMappingPersonalityOptions?.();
            }
          }
        })();
      });

      const info = document.createElement('div');
      info.dataset.role = 'mapping-info';
      info.style.fontSize = '12px';
      info.style.color = 'var(--chatgoose-ink-mid)';
      info.textContent = `${mappedView?.label ?? 'Unmapped'}${mappedView && !mappedView.usable ? ' · unavailable' : ''} \u2022 ${session?.connected ? 'Connected' : 'Disconnected'}`;

      row.append(label, select, info);
      mappingsTable.append(row);
    });

    if (state.knownAccounts.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No Fansly accounts detected yet.';
      empty.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(empty);
    }
  };

  const renderConnections = (
    sessions: SessionSnapshotEntry[],
    hydrationFailed: boolean,
  ): void => {
    sessionsGrid.replaceChildren();
    connectionsSection.dataset.sessionHydration = hydrationFailed ? 'failed' : 'ready';

    if (hydrationFailed) {
      const error = document.createElement('div');
      error.textContent = 'Could not load live connection status. Reload Settings to try again.';
      error.style.color = 'var(--chatgoose-bad)';
      sessionsGrid.append(error);
      return;
    }

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
        right.textContent = session.connected ? 'Connected' : 'Disconnected';
        right.style.color = session.connected ? 'var(--chatgoose-green)' : 'var(--chatgoose-bad)';
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
  };

  const hydrateAccountSections = async (): Promise<void> => {
    const result = await sessionsResultPromise;
    if (disposed) {
      return;
    }

    if (!result.ok) {
      console.error('Failed to load Fansly sessions for Settings', result.error);
      renderAccountMappings([], true);
      renderConnections([], true);
      return;
    }

    // The runtime snapshot performs identity rekey/reconciliation. Read only
    // after it resolves, then copy only account-owned fields into this render's
    // state so unrelated local form state cannot be replaced by a stale read.
    try {
      const refreshedState = await loadStorageState();
      if (disposed) {
        return;
      }
      state.accountMappings = refreshedState.accountMappings;
      state.accountAliases = refreshedState.accountAliases;
      state.knownAccounts = refreshedState.knownAccounts;
      renderAccountMappings(result.sessions, false);
      renderConnections(result.sessions, false);
    } catch (error) {
      console.error('Failed to refresh account state for Settings', error);
      if (!disposed) {
        renderAccountMappings([], true);
        renderConnections([], true);
      }
    }
  };

  void hydrateAccountSections();

  renderCleanup = async () => {
    const pendingEdits = flushPendingEdits();
    cleanupTasks.forEach((cleanup) => cleanup());
    await pendingEdits;
    renderCleanup = null;
  };

  await refreshAgencyHubPermissionState();
  await runAgencyHubConnectionTest({ force: true });
  // A successful connection test waits for the background catalog refresh.
  // Merge only catalog fields so account hydration and form edits keep their
  // narrow ownership boundaries.
  try {
    const refreshedCatalogState = await readStorageState();
    if (!disposed) {
      state.personaCatalog = refreshedCatalogState.personaCatalog;
      state.personaCatalogSource = refreshedCatalogState.personaCatalogSource;
      state.personaCatalogFetchedAt = refreshedCatalogState.personaCatalogFetchedAt;
      renderPersonaCatalog();
      refreshAccountMappingPersonalityOptions?.();
    }
  } catch (error) {
    console.error('Failed to refresh persona catalog view', error);
  }
}

injectStyles(optionsStyles);
void render();
