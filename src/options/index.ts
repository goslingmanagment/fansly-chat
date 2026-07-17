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
import { COPY } from './copy.js';
import {
  createBadge,
  createButton,
  createCap,
  createChipGroup,
  createLabelRow,
  createSavedFlash,
  createSection,
  createStatusRow,
  createToggle,
  createVersionTag,
  debounce,
  injectStyles,
  type BadgeTone,
} from './dom.js';
import {
  buildSessionLookup,
  formatAccountHeading,
  formatAccountMeta,
  formatCaptureStatus,
} from './sessions.js';
import { buildShell } from './shell.js';
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
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AiQuotaStatus,
  PersonaCatalogEntry,
  SessionSnapshotEntry,
  Settings,
  SpendersStreamState,
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
  const downloadExport = createButton('Скачать JSON легаси-персон', true);
  downloadExport.addEventListener('click', () => {
    downloadExport.disabled = true;
    void exportJson().then((json) => {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `chatgoose-legacy-personas-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      exportStatus.textContent = 'JSON легаси-персон скачан.';
    }).catch((error: unknown) => {
      console.error('Failed to export legacy persona data', error);
      exportStatus.textContent = 'Экспорт не удался. Перезагрузи настройки и попробуй снова.';
    }).finally(() => {
      downloadExport.disabled = false;
    });
  });
  const copyExport = createButton('Скопировать JSON легаси-персон', true);
  copyExport.addEventListener('click', () => {
    copyExport.disabled = true;
    void exportJson().then(async (json) => {
      await navigator.clipboard.writeText(json);
      exportStatus.textContent = 'JSON легаси-персон скопирован.';
    }).catch((error: unknown) => {
      console.error('Failed to copy legacy persona data', error);
      exportStatus.textContent = 'Копирование не удалось. Используй «Скачать».';
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
  title.textContent = 'Восстановление персон';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'Сохранённый снапшот легаси-персон повреждён. Обычные настройки и доступ к Agency Hub отключены, чтобы снапшот нельзя было перезаписать.';
  subtitle.style.color = 'var(--chatgoose-ink-mid)';
  hero.append(createVersionTag(extensionVersion), title, subtitle);

  const recovery = createSection(
    'Экспорт легаси-персон',
    'Экспортируй повреждённое сохранённое значение вместе с текущими легаси-персонами, привязками и алиасами для ручного восстановления.',
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
  title.textContent = COPY.pageTitle;
  title.style.margin = '0';
  const subtitle = document.createElement('div');
  subtitle.textContent = COPY.pageSubtitle;
  subtitle.style.color = 'var(--chatgoose-ink-mid)';
  hero.append(createVersionTag(extensionVersion), title, subtitle);
  root.append(hero);

  // ─── Readiness hero (route → pulse) ─────────────────────────
  // Derives entirely from the SAME `statusModel` the Статус rows paint from —
  // zero new requests, no own fetch. Rendered by `updateReadinessHero` below.
  const readinessHero = document.createElement('section');
  readinessHero.className = 'chatgoose-readiness';
  readinessHero.dataset.readinessHero = 'true';
  root.append(readinessHero);

  // ─── Shell (nav + main) ─────────────────────────────────────
  // Nav order == card order == the registration order below. Sections are
  // built in place further down and registered as one ordered block, anchored
  // immediately before the future-schema barrier so its catch-up can find and
  // disable the real controls (see the registration block for the invariant).
  const shell = buildShell([
    { id: 'status', title: COPY.nav.status },
    { id: 'hub', title: COPY.nav.hub },
    { id: 'personas', title: COPY.nav.personas },
    { id: 'accounts', title: COPY.nav.accounts },
    { id: 'generation', title: COPY.nav.generation },
    { id: 'appearance', title: COPY.nav.appearance },
    { id: 'version', title: COPY.nav.version },
  ]);
  root.append(shell.layout);
  cleanupTasks.push(() => shell.dispose());

  // Central save feedback. Mounted once per render as a direct child of root,
  // never on the legacy-persona recovery page path. Success save paths call
  // showSaved(); caught save errors ALSO call showError() beside (never
  // replacing) their existing console.error.
  const savedFlash = createSavedFlash();
  savedFlash.root.dataset.savedFlash = 'true';
  root.append(savedFlash.root);

  // ─── Appearance ─────────────────────────────────────────────
  const appearanceSection = createSection(
    COPY.sections.appearanceTitle,
    COPY.sections.appearanceHint,
  );
  // The chip group's hidden <select> is `themeSelect` — the SAME binding the
  // form signature, listener array, and pagehide path already read. Clicking a
  // chip fires input/change on that select, so the central save controller
  // persists uiTheme with zero edits to the save logic below.
  const themeChips = createChipGroup(
    [
      { value: 'system', label: 'Системная' },
      { value: 'light', label: 'Светлая' },
      { value: 'dark', label: 'Тёмная' },
    ],
    state.settings.uiTheme,
  );
  const themeSelect = themeChips.input;
  appearanceSection.append(themeChips.root);

  // ─── Generation settings (Stage 32: keys/models are kernel-side) ────
  const apiSection = createSection(
    COPY.sections.generationTitle,
    COPY.sections.generationHint,
  );

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

  const countsGrid = document.createElement('div');
  countsGrid.className = 'chatgoose-counts-grid';
  const countField = (label: string, input: HTMLInputElement): HTMLElement => {
    input.classList.add('chatgoose-num');
    const wrap = document.createElement('label');
    wrap.className = 'chatgoose-count-field';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(text, input);
    return wrap;
  };
  countsGrid.append(
    countField('Reply + Help', quickInput),
    countField('Ping', pingInput),
    countField('Fix', improveInput),
    countField('Deep — Summary, Review', deepInput),
  );

  // `debugInput` keeps its name: it is now the toggle's hidden checkbox, still
  // in the listener array and form signature, so no save logic changes.
  const advanced = document.createElement('div');
  advanced.className = 'chatgoose-advanced';
  const debugToggle = createToggle('Debug mode', 'окно отладки промпта');
  const debugInput = debugToggle.input;
  debugInput.checked = state.settings.debugMode;
  advanced.append(createCap('Дополнительно'), debugToggle.root);
  apiSection.append(countsGrid, advanced);

  // ─── Agency Hub ───────────────────────────────────────────
  const agencyHubSection = createSection(
    COPY.sections.hubTitle,
    COPY.sections.hubHint,
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
  // The field lives inside a collapsed <details>; give it a standalone
  // accessible name since its <summary> label is not programmatically linked.
  agencyHubKeyInput.setAttribute('aria-label', 'Legacy chatter key');
  agencyHubKeyInput.value = state.settings.agencyHubApiKey;

  const agencyHubToggle = createButton('Показать', true);
  agencyHubToggle.addEventListener('click', () => {
    agencyHubKeyInput.type = agencyHubKeyInput.type === 'password' ? 'text' : 'password';
    agencyHubToggle.textContent = agencyHubKeyInput.type === 'password' ? 'Показать' : 'Скрыть';
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

  const agencyHubPermissionButton = createButton('Разрешить доступ', true);
  const agencyHubConnectionStatus = document.createElement('div');
  agencyHubConnectionStatus.style.fontWeight = '600';
  agencyHubConnectionStatus.style.fontSize = '14px';

  const agencyHubConnectionMeta = document.createElement('div');
  agencyHubConnectionMeta.style.color = 'var(--chatgoose-ink-mid)';
  agencyHubConnectionMeta.style.fontSize = '13px';

  const agencyHubConnectionButton = createButton('Проверить соединение', true);

  let agencyHubConnectionVersion = 0;
  let lastAgencyHubConnectionSignature: string | null = null;

  const renderAgencyHubConnectionState = (): void => {
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const hasInputs = hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken);

    agencyHubConnectionButton.disabled =
      agencyHubConnectionFeedback.kind === 'testing' || !hasInputs;

    switch (agencyHubConnectionFeedback.kind) {
      case 'idle':
        agencyHubConnectionStatus.textContent = 'Ещё не проверялось.';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Сохрани адрес Hub и ключ, чтобы запустить живой тест соединения.';
        return;
      case 'pending':
        agencyHubConnectionStatus.textContent = 'Статус соединения обновляется…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Сохраняю изменения Agency Hub перед следующим живым тестом.';
        return;
      case 'testing':
        agencyHubConnectionStatus.textContent = 'Проверяю соединение…';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-ink)';
        agencyHubConnectionMeta.textContent = 'Проверяю доступность Hub, разрешения и ключ.';
        return;
      case 'connected':
        agencyHubConnectionStatus.textContent = 'Соединение OK ✓';
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-green)';
        agencyHubConnectionMeta.textContent = `Живой тест соединения прошёл: ${agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || 'Agency Hub'}.`;
        return;
      case 'failed': {
        const failedError = agencyHubConnectionFeedback.error;
        const description = getUserErrorDescription(failedError);
        agencyHubConnectionStatus.textContent = `Соединение не удалось: ${failedError.code}`;
        agencyHubConnectionStatus.style.color = 'var(--chatgoose-bad)';
        const serverEcho = typeof failedError.httpStatus === 'number'
          ? `Hub ответил ${failedError.httpStatus}${failedError.serverDetail ? `: ${failedError.serverDetail}` : ''}`
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
          description: 'Не удалось выполнить проверку соединения.',
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

    agencyHubPermissionButton.textContent = permissionGranted ? 'Переподключить' : 'Разрешить доступ';
    agencyHubPermissionButton.disabled = !originPattern;

    // Badge reflection computed ONCE here — after the staleness guard (a
    // superseded refresh must not restamp it) but before the seven status
    // early returns below, so no forgotten branch can strand it on the «…»
    // placeholder. permissionBadge is created in the section composition
    // below and only ever read here, long after that runs (E37 barrier).
    const setPermissionBadge = (label: string, tone: 'green' | 'amber' | 'neutral'): void => {
      permissionBadge.textContent = label;
      permissionBadge.className = `chatgoose-badge chatgoose-badge-${tone}`;
      permissionBadge.dataset.hubPermissionBadge = 'true';
    };
    if (!originPattern) {
      setPermissionBadge('нет адреса', 'neutral'); // empty or invalid hub URL
    } else if (permissionGranted) {
      setPermissionBadge('разрешён', 'green'); // covers granted+no-credential too
    } else if (permissionCheck.errorMessage) {
      setPermissionBadge('не удалось проверить', 'neutral'); // a failed check is NOT a proven «не выдан»
    } else {
      setPermissionBadge('не выдан', 'amber');
    }

    if (!agencyHubUrlInput.value.trim()) {
      agencyHubPermissionStatus.textContent = 'Синк отключён: добавь адрес Agency Hub.';
      agencyHubPermissionMeta.textContent = 'Укажи базовый адрес Hub и выдай доступ к этому origin.';
      return;
    }

    if (!normalizedBaseUrl) {
      agencyHubPermissionStatus.textContent = 'Синк отключён: неверный адрес Agency Hub.';
      agencyHubPermissionMeta.textContent = 'Укажи полный http:// или https:// адрес.';
      return;
    }

    if (!permissionGranted) {
      const permissionFeedback =
        agencyHubPermissionFeedback?.originPattern === originPattern
          ? agencyHubPermissionFeedback
          : null;

      if (permissionCheck.errorMessage) {
        agencyHubPermissionStatus.textContent = 'Синк отключён: не удалось проверить доступ к хосту.';
        agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
          `Firefox вернул ошибку при проверке ${originPattern}: ${permissionCheck.errorMessage}.`,
          permissionScopeNote,
        );
        return;
      }

      if (permissionFeedback) {
        switch (permissionFeedback.kind) {
          case 'denied':
            agencyHubPermissionStatus.textContent = 'Синк отключён: доступ к хосту не выдан.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              `Firefox не выдал доступ к ${originPattern}. Нажми «Разрешить доступ», чтобы повторить.`,
              permissionScopeNote,
            );
            return;
          case 'request_error':
            agencyHubPermissionStatus.textContent = 'Синк отключён: не удалось запросить доступ к хосту.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              `Firefox вернул ошибку при запросе ${originPattern}: ${permissionFeedback.errorMessage}.`,
              permissionScopeNote,
            );
            return;
          case 'unsupported':
            agencyHubPermissionStatus.textContent = 'Синк отключён: запрос доступа к хосту недоступен.';
            agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
              'Эта сборка браузера не предоставляет browser.permissions.request для доступа к Agency Hub.',
              permissionScopeNote,
            );
            return;
        }
      }

      if (typeof browser.permissions?.request !== 'function') {
        agencyHubPermissionStatus.textContent = 'Синк отключён: запрос доступа к хосту недоступен.';
        agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
          'Эта сборка браузера не предоставляет browser.permissions.request для доступа к Agency Hub.',
          permissionScopeNote,
        );
        return;
      }

      agencyHubPermissionStatus.textContent = 'Синк отключён: доступ к хосту не выдан.';
      agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
        `Выдай доступ к ${originPattern}, чтобы ChatGoose мог отправлять сводки.`,
        permissionScopeNote,
      );
      return;
    }

    if (!hasApiKey) {
      agencyHubPermissionStatus.textContent = 'Синк отключён: нет учётных данных Agency Hub.';
      agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
        `Доступ к ${originPattern} выдан, но ChatGoose нужны учётные данные — войди или добавь ключ Hub.`,
        permissionScopeNote,
      );
      return;
    }

    // Never claim readiness here: this is a local check (permission + a
    // non-empty credential) — only the live connection test below proves sync.
    agencyHubPermissionStatus.textContent = 'Доступ к хосту выдан.';
    agencyHubPermissionMeta.textContent = appendAgencyHubMeta(
      `ChatGoose может достучаться до ${originPattern}. Синк заработает, когда пройдёт проверка соединения ниже.`,
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
  hubSignInUserInput.placeholder = 'Логин Hub';

  const hubSignInPasswordInput = document.createElement('input');
  hubSignInPasswordInput.type = 'password';
  hubSignInPasswordInput.autocomplete = 'current-password';
  hubSignInPasswordInput.className = 'chatgoose-input';
  hubSignInPasswordInput.placeholder = 'Пароль Hub';

  const hubSignInButton = createButton('Войти и выпустить token', true);
  const hubSignInStatus = document.createElement('div');
  hubSignInStatus.style.fontWeight = '600';
  hubSignInStatus.style.fontSize = '14px';
  const hubSignInMeta = document.createElement('div');
  hubSignInMeta.style.color = 'var(--chatgoose-ink-mid)';
  hubSignInMeta.style.fontSize = '13px';

  const renderHubSignInState = (): void => {
    const hasToken = Boolean(state.settings.agencyHubDeviceToken.trim());
    hubSignInStatus.textContent = hasToken
      ? 'Device token активен ✓'
      : 'Device token ещё не выпущен.';
    hubSignInStatus.style.color = hasToken
      ? 'var(--chatgoose-green)'
      : 'var(--chatgoose-ink)';
    if (!hubSignInMeta.textContent) {
      hubSignInMeta.textContent = hasToken
        ? 'Запросы к Hub используют device token; legacy-ключ — запасной вариант.'
        : 'Войди один раз, чтобы выпустить привязанный к устройству token — больше не нужно вставлять ключ, и он переживает ротацию ключа.';
    }
  };

  hubSignInButton.addEventListener('click', () => {
    void (async () => {
      const username = hubSignInUserInput.value.trim();
      const password = hubSignInPasswordInput.value;
      if (!username || !password || !agencyHubUrlInput.value.trim()) {
        hubSignInMeta.textContent = 'Сначала укажи адрес Hub, логин и пароль.';
        return;
      }
      hubSignInButton.disabled = true;
      hubSignInMeta.textContent = 'Вхожу…';
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
          // The freshly-issued device token makes checkIdentity return AUTH, so
          // the Доступ row (and the hero) flip in place — no reload, no remount.
          void hydrateHubStatusRows(storedHubSignature());
          hubSignInPasswordInput.value = '';
          hubSignInMeta.textContent =
            `Device token ${response.keyPrefix}… выпущен (истекает ${new Date(response.expiresAt).toLocaleDateString()}).`;
        } else {
          hubSignInMeta.textContent = `Вход не удался: ${response.error.message}`;
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

  const hubSignInBlock = document.createElement('div');
  hubSignInBlock.style.display = 'grid';
  hubSignInBlock.style.gap = '7px';
  hubSignInBlock.append(hubSignInRow, hubSignInStatus, hubSignInMeta);

  const permissionBadge = createBadge('…', 'neutral');
  permissionBadge.dataset.hubPermissionBadge = 'true';
  const permissionBlock = document.createElement('div');
  permissionBlock.style.display = 'grid';
  permissionBlock.style.gap = '6px';
  const permissionTop = document.createElement('div');
  permissionTop.style.display = 'flex';
  permissionTop.style.gap = '8px';
  permissionTop.style.alignItems = 'center';
  permissionTop.append(permissionBadge, agencyHubPermissionButton);
  permissionBlock.append(permissionTop, agencyHubPermissionStatus, agencyHubPermissionMeta);

  const legacyDetails = document.createElement('details');
  legacyDetails.className = 'chatgoose-hub-legacy';
  const legacySummary = document.createElement('summary');
  legacySummary.textContent = 'Legacy chatter key — на период миграции';
  legacyDetails.append(legacySummary, agencyHubKeyRow);

  const testLine = document.createElement('div');
  testLine.dataset.hubTestLine = 'true';
  testLine.append(agencyHubConnectionStatus, agencyHubConnectionMeta);
  const hubFooter = document.createElement('div');
  hubFooter.className = 'chatgoose-hub-footer';
  hubFooter.append(testLine, agencyHubConnectionButton);

  agencyHubSection.append(
    createLabelRow('Адрес Hub', agencyHubUrlInput),
    createLabelRow('Вход устройства', hubSignInBlock),
    createLabelRow('Доступ Firefox', permissionBlock),
    legacyDetails,
    hubFooter,
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
      savedFlash.showSaved();

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
          // Repaint Статус against the snapshot THIS persist wrote. The guard
          // inside binds to `hubSignature`, so a run this persist fired against
          // hub B silently drops if the live field has since moved to hub C.
          await hydrateHubStatusRows(hubSignature);
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
        savedFlash.showError('настройки не сохранились — повтори');
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

  [
    themeSelect,
    agencyHubUrlInput,
    agencyHubKeyInput,
    quickInput,
    pingInput,
    improveInput,
    deepInput,
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
        // A granted origin flips a `no_permission` Hub/Доступ verdict to live
        // without a reload. No unsaved edit is in play at a permission event,
        // so the stored-settings signature is the expected snapshot.
        await hydrateHubStatusRows(storedHubSignature());
      })();
    };

    browser.permissions.onAdded.addListener(handlePermissionChanged);
    browser.permissions.onRemoved.addListener(handlePermissionChanged);
    cleanupTasks.push(() => {
      browser.permissions.onAdded.removeListener(handlePermissionChanged);
      browser.permissions.onRemoved.removeListener(handlePermissionChanged);
    });
  }
  // ─── Persona catalog (server-owned, metadata only) ─────────
  const personalitiesSection = createSection(
    COPY.sections.personasTitle,
    'Голоса управляются на сервере агентства; здесь — только каталог и привязки аккаунтов.',
  );
  const personalitiesList = document.createElement('div');
  personalitiesList.style.display = 'grid';
  personalitiesList.style.gap = '10px';
  let refreshAccountMappingPersonalityOptions: (() => void) | null = null;

  const renderPersonaCatalog = (): void => {
    personalitiesList.replaceChildren();
    if (state.personaCatalog.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Каталог персон пуст — проверь подключение к Hub. Голоса приходят с сервера; их редактирование сейчас заморожено.';
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
      meta.textContent = `${persona.key} • версия ${persona.version} • ${persona.status === 'active' ? 'активна' : 'в архиве'}`;
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
  preservationNote.textContent = 'Легаси-тексты персон сохранены на этом устройстве без изменений. Экспортируй их перед удалением расширения или очисткой браузера.';
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

  // ─── Аккаунты (merged: mappings + live capture status) ─────
  const mappingsSection = createSection(
    COPY.sections.accountsTitle,
    COPY.sections.accountsHint,
  );
  mappingsSection.dataset.sessionHydration = 'loading';
  const mappingsTable = document.createElement('div');
  mappingsTable.style.display = 'grid';
  mappingsTable.style.gap = '12px';
  const mappingsLoading = document.createElement('div');
  mappingsLoading.textContent = 'Загружаю аккаунты Fansly…';
  mappingsLoading.style.color = 'var(--chatgoose-ink-mid)';
  mappingsTable.append(mappingsLoading);
  mappingsSection.append(mappingsTable);

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
    unmapped.textContent = '— не назначена —';
    select.replaceChildren(unmapped);
    for (const view of views) {
      const option = document.createElement('option');
      option.value = view.personality.key;
      option.textContent = view.usable
        ? view.label
        : `${view.label} · в архиве`;
      option.disabled = !view.usable;
      select.append(option);
    }

    const selectedView = views.find(
      (view) => view.personality.key === selectedPersonalityId,
    ) ?? null;
    if (selectedPersonalityId && !selectedView) {
      const missing = document.createElement('option');
      missing.value = selectedPersonalityId;
      missing.textContent = `Персона недоступна · ${selectedPersonalityId}`;
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

  // [data-role="mapping-info"] carries persona availability ONLY (label /
  // archived / unavailable). Session state lives in the identity block's
  // capture line — the old "• Connected|Disconnected" tail is gone from both
  // build sites so the two views never disagree.
  const formatMappingInfo = (
    view: { label: string; usable: boolean } | null,
  ): string => `${view?.label ?? '— не назначена —'}${view && !view.usable ? ' · недоступна' : ''}`;

  // The amber "AI отключён" badge tracks the mapping select, not the session.
  // It lives inside the identity block (never a fifth grid child) and toggles
  // wherever the select's value can change: render, change handler, catalog
  // refresh.
  const syncAccountAiBadge = (select: HTMLSelectElement): void => {
    const identity = select
      .closest<HTMLElement>('[data-account-mapping-row]')
      ?.querySelector<HTMLElement>('[data-role="account-identity"]');
    if (!identity) {
      return;
    }
    const existing = identity.querySelector('.chatgoose-badge-amber');
    if (select.value === '') {
      if (!existing) {
        identity.append(createBadge('AI отключён', 'amber'));
      }
    } else if (existing) {
      existing.remove();
    }
  };

  const accountAvatarInitials = (heading: string): string => {
    const words = heading.replace(/^@+/, '').trim().split(/\s+/).filter(Boolean);
    const initials = words.slice(0, 2).map((word) => word.charAt(0)).join('');
    return initials ? initials.toUpperCase() : '?';
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
        info.textContent = formatMappingInfo(selectedView);
      }
      syncAccountAiBadge(select);
    }
  };

  // ─── Version ────────────────────────────────────────────────
  const versionSection = createSection(COPY.sections.versionTitle, COPY.sections.versionHint);
  const versionLine = document.createElement('div');
  versionLine.className = 'chatgoose-num';
  versionLine.style.fontSize = '12px';
  versionLine.style.color = 'var(--chatgoose-ink-mid)';
  versionLine.textContent = `v ${extensionVersion} · канал: self-hosted feed`;
  // The anchored changelog.html deploys via the parallel changelog track; the
  // anchor is `v<major>-<minor>-<patch>` derived from the manifest version.
  const changelogButton = createButton(COPY.version.changelogButton, true);
  changelogButton.addEventListener('click', () => {
    const anchor = `v${extensionVersion.replace(/\./g, '-')}`;
    void browser.tabs.create({ url: `https://ext.gosling-agency.ru/changelog.html#${anchor}` });
  });
  versionSection.append(versionLine, changelogButton);

  // ─── Статус (read-only state rows) ─────────────────────────
  const statusSection = createSection(COPY.sections.statusTitle, COPY.sections.statusHint);
  const statusRows = {
    fansly: createStatusRow(COPY.status.fanslyLabel),
    hub: createStatusRow(COPY.status.hubLabel),
    access: createStatusRow(COPY.status.accessLabel),
    ai: createStatusRow(COPY.status.aiLabel),
    spenders: createStatusRow(COPY.status.spendersLabel),
    contract: createStatusRow(COPY.status.contractLabel),
  };
  for (const row of Object.values(statusRows)) row.skeleton();
  // The Контракт row is debug-only (spec §5). Hide it unless debugMode; the
  // row still hydrates so toggling debug and reloading shows a live value.
  if (!state.settings.debugMode) statusRows.contract.root.hidden = true;
  statusSection.append(
    statusRows.fansly.root,
    statusRows.hub.root,
    statusRows.access.root,
    statusRows.ai.root,
    statusRows.spenders.root,
    statusRows.contract.root,
  );

  // Shared read-only model the Статус rows and the readiness hero both read.
  // Rows are painted directly here; the hero (Task 8) re-renders from this.
  const statusModel: {
    fanslyAccounts: number;
    // The account ids that currently have a CAPTURED session — the hero's step-3
    // readiness reads only this set, never every knownAccount (an offline
    // historical account with an archived mapping must not block «Всё работает»).
    fanslyCapturedAccountIds: string[];
    fanslyFreshest: SessionSnapshotEntry | undefined;
    health: AgencyHubHealthResponse | null;
    identity: AgencyHubIdentityResponse | null;
  } = { fanslyAccounts: 0, fanslyCapturedAccountIds: [], fanslyFreshest: undefined, health: null, identity: null };

  const isAccountPersonaMapped = (accountId: string): boolean => {
    const mappedKey = state.accountMappings[accountId] ?? '';
    return Boolean(mappedKey) && state.personaCatalog.some(
      (persona) => persona.key === mappedKey && persona.status === 'active',
    );
  };

  const pluralizeSteps = (count: number): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'шаг';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'шага';
    return 'шагов';
  };
  const updateReadinessHero = (): void => {
    const hubDone = statusModel.identity?.ok === true;
    const fanslyDone = statusModel.fanslyCapturedAccountIds.length > 0;
    // ONLY accounts with a captured session need an active persona (spec §4).
    // An offline historical account carrying an archived mapping has no captured
    // session, so it is absent from this set and never blocks «Всё работает».
    const mappedDone = fanslyDone &&
      statusModel.fanslyCapturedAccountIds.every((id) => isAccountPersonaMapped(id));

    // On a fresh install the real step-1 blocker is the host-permission grant,
    // not sign-in — offer «Разрешить доступ» (still anchored to the hub section)
    // when checkHealth/checkIdentity reported no_permission, so the hero never
    // mislabels the action as «Войти».
    const permissionBlocked =
      (statusModel.health?.ok === false && statusModel.health.reason === 'no_permission') ||
      (statusModel.identity?.ok === false && statusModel.identity.reason === 'no_permission');

    const steps = [
      { done: hubDone,
        label: permissionBlocked ? COPY.hero.step1Permission : COPY.hero.step1,
        action: permissionBlocked ? COPY.hero.step1PermissionAction : COPY.hero.step1Action,
        run: () => agencyHubSection.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      { done: fanslyDone, label: COPY.hero.step2, action: COPY.hero.step2Action,
        run: () => { void browser.tabs.create({ url: 'https://fansly.com' }); } },
      { done: mappedDone, label: COPY.hero.step3, action: COPY.hero.step3Action,
        run: () => mappingsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    ];
    const open = steps.filter((step) => !step.done);
    readinessHero.replaceChildren();

    if (open.length === 0) {
      readinessHero.dataset.heroState = 'pulse';
      const dot = document.createElement('span');
      dot.className = 'chatgoose-readiness-dot';
      const line = document.createElement('span');
      line.className = 'chatgoose-readiness-pulse';
      line.textContent = COPY.hero.allGood;
      const facts = document.createElement('span');
      facts.className = 'chatgoose-num chatgoose-readiness-facts';
      const spendersBadge = statusRows.spenders.root.querySelector('.chatgoose-badge-mono')?.textContent ?? '—';
      facts.textContent = `Fansly ${statusModel.fanslyAccounts} · Hub ✓ · Spenders ${spendersBadge}`;
      const expand = createButton(COPY.hero.expand, true);
      expand.addEventListener('click', () => statusSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      readinessHero.append(dot, line, facts, expand);
      return;
    }

    readinessHero.dataset.heroState = 'route';
    const heading = document.createElement('h2');
    heading.className = 'chatgoose-readiness-heading';
    heading.textContent = `${COPY.hero.stepsPrefix} ${open.length} ${pluralizeSteps(open.length)}`;
    readinessHero.append(heading);
    for (const step of steps) {
      const stepRow = document.createElement('div');
      stepRow.className = 'chatgoose-readiness-step';
      stepRow.dataset.done = String(step.done);
      const mark = document.createElement('span');
      mark.textContent = step.done ? '✓' : '•';
      const text = document.createElement('span');
      text.textContent = step.label;
      stepRow.append(mark, text);
      if (!step.done) {
        const button = createButton(step.action, true);
        button.addEventListener('click', step.run);
        stepRow.append(button);
      }
      readinessHero.append(stepRow);
    }
  };
  updateReadinessHero(); // initial paint from skeleton state (all open)

  const paintFanslyStatusRow = (sessions: SessionSnapshotEntry[], failed: boolean): void => {
    if (failed) {
      statusRows.fansly.set({ badge: 'OFF', tone: 'neutral', fact: 'живой статус недоступен' });
      return;
    }
    const lookup = buildSessionLookup(sessions);
    // The captured-session account ids drive BOTH the Fansly row count and the
    // hero's step-3 readiness. An account with no captured session needs no
    // persona (spec §4), so it must never enter this set.
    const capturedAccountIds = state.knownAccounts.filter(
      (id) => lookup.get(id)?.connected === true,
    );
    statusModel.fanslyCapturedAccountIds = capturedAccountIds;
    statusModel.fanslyAccounts = capturedAccountIds.length;
    statusModel.fanslyFreshest = capturedAccountIds
      .map((id) => lookup.get(id))
      .filter((s): s is SessionSnapshotEntry => Boolean(s))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (capturedAccountIds.length === 0) {
      statusRows.fansly.set({ badge: 'OFF', tone: 'amber', fact: COPY.status.fanslyEmpty });
    } else {
      statusRows.fansly.set({
        badge: 'CAPTURED',
        tone: 'green',
        fact: `${capturedAccountIds.length} акк.`,
        detail: formatCaptureStatus(statusModel.fanslyFreshest),
      });
    }
    updateReadinessHero(); // Task 8 (no-op until then)
  };

  // The live connection signature the hub fields currently show. The guard binds
  // to the PERSISTED snapshot: the caller passes the signature of what it just
  // persisted, and this run is valid only while the live form still equals it.
  const currentHubSignature = (): string =>
    buildAgencyHubConnectionSignature(
      agencyHubUrlInput.value,
      agencyHubKeyInput.value,
      state.settings.agencyHubDeviceToken,
    );
  // The signature of the SAVED settings — what mount, the sign-in success path,
  // and the permission grant pass as their expected snapshot (no unsaved edit is
  // in play at those moments; the form equals stored). The post-persist caller
  // instead passes its own freshly-computed `hubSignature` from `mergedSettings`.
  const storedHubSignature = (): string =>
    buildAgencyHubConnectionSignature(
      state.settings.agencyHubBaseUrl,
      state.settings.agencyHubApiKey,
      state.settings.agencyHubDeviceToken,
    );
  const hydrateHubStatusRows = async (expectedSignature: string): Promise<void> => {
    // (1) Delayed-START guard — BEFORE issuing any request. If the live form has
    // already moved on from the snapshot this run was fired for, skip entirely:
    // the user is mid-edit and a newer persist will re-trigger with its own
    // signature. Firing a doomed pair of hub requests here is the storm we avoid.
    if (disposed || currentHubSignature() !== expectedSignature) return;
    for (const row of [statusRows.hub, statusRows.access]) row.skeleton();
    statusRows.hub.setAction(null);
    // Independent sources (§12): a rejected transport on ONE read must not leave
    // the OTHER row a skeleton nor surface as an unhandled rejection. allSettled
    // lets each row render its own honest state.
    const [healthResult, identityResult] = await Promise.allSettled([
      sendRuntimeRequest('getAgencyHubHealth'),
      sendRuntimeRequest('getAgencyHubIdentity'),
    ]);
    // (2) In-flight guard — re-check before PAINTING. The reads pull SAVED
    // settings background-side, so a paint is only valid while the live form
    // still equals the persisted snapshot this run fired for; a mid-flight edit
    // drops the result (that edit's own persist re-runs hydration). No generation
    // counter — the persisted signature is the sole binding.
    if (disposed || currentHubSignature() !== expectedSignature) return;
    // A fulfilled read still has to be a well-formed response — a transport that
    // resolves `undefined` (a harness with no handler, a truncated frame) is a
    // failure, never invented into a verdict: fall to honest «unreachable».
    const isOkResponse = (value: unknown): value is { ok: boolean } =>
      typeof value === 'object' && value !== null && 'ok' in value;
    const health: AgencyHubHealthResponse = healthResult.status === 'fulfilled' && isOkResponse(healthResult.value)
      ? healthResult.value
      : { ok: false, reason: 'unreachable' };
    const identity: AgencyHubIdentityResponse = identityResult.status === 'fulfilled' && isOkResponse(identityResult.value)
      ? identityResult.value
      : { ok: false, reason: 'unreachable' };
    statusModel.health = health;
    statusModel.identity = identity;

    // Hub (core)
    if (health.ok) {
      statusRows.hub.set({
        badge: health.status === 'degraded' ? 'DEGRADED' : 'UP',
        tone: health.status === 'degraded' ? 'amber' : 'green',
        fact: health.status === 'degraded' ? 'ядро деградировано' : 'ядро отвечает',
        detail: health.dbLatencyMs === null ? undefined : `DB latency ${health.dbLatencyMs} мс`,
      });
    } else if (health.reason === 'no_base_url') {
      statusRows.hub.set({ badge: 'DOWN', tone: 'neutral', fact: COPY.status.hubEmpty });
    } else if (health.reason === 'no_permission') {
      // A fresh install has no host permission (permissions.contains defaults
      // false) — that is NOT a down core. Distinct amber badge + a grant action
      // anchored to the hub section (where the permission button lives), so the
      // renderer never falls through to a false red «ядро недоступно».
      statusRows.hub.set({ badge: 'НЕТ ДОСТУПА', tone: 'amber', fact: COPY.status.hubNoPermission });
      const grant = createButton(COPY.status.grantAccess, true);
      grant.addEventListener('click', () => {
        agencyHubSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      statusRows.hub.setAction(grant);
    } else {
      statusRows.hub.set({ badge: 'DOWN', tone: 'bad', fact: 'ядро недоступно' });
    }

    // Доступ — CREDENTIAL validity only, never a hub-health verdict (§14).
    statusRows.access.setAction(null);
    if (identity.ok) {
      statusRows.access.set({
        badge: 'AUTH',
        tone: 'green',
        fact: `${identity.username} · ${identity.role}`,
        detail: `pages: ${identity.pages.length}`,
      });
    } else if (identity.reason === 'unauthorized') {
      statusRows.access.set({ badge: '401', tone: 'bad', fact: 'credential отклонён хабом' });
      const reLogin = createButton(COPY.status.reLogin, true);
      reLogin.addEventListener('click', () => {
        agencyHubSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      statusRows.access.setAction(reLogin);
    } else if (identity.reason === 'no_credential') {
      statusRows.access.set({ badge: 'НЕТ CREDENTIAL', tone: 'neutral', fact: COPY.status.accessEmpty });
    } else {
      // no_permission and unreachable are HUB-health conditions, not credential
      // verdicts — the Доступ badge stays neutral «НЕИЗВЕСТНО» (the blocker is
      // surfaced on the Hub row), never a red «НЕТ CREDENTIAL».
      statusRows.access.set({ badge: 'НЕИЗВЕСТНО', tone: 'neutral', fact: COPY.status.accessUnknown });
    }

    // Контракт (debug only; derived from the same health response)
    if (health.ok) {
      const match = health.contractHash === health.sdkContractHash;
      statusRows.contract.set({
        badge: match ? 'MATCH' : 'DRIFT',
        tone: match ? 'green' : 'bad',
        fact: match ? 'контракт совпадает' : 'контракт разошёлся с SDK',
      });
    } else {
      statusRows.contract.set({ badge: '—', tone: 'neutral', fact: 'контракт неизвестен' });
    }

    updateReadinessHero(); // Task 8
  };

  const hydrateLocalStatusRows = async (): Promise<void> => {
    // Independent sources (§12): one rejected local read must not strand the
    // other row as a skeleton or raise an unhandled rejection. A rejected source
    // falls to its honest-unknown render ({} / null), never a stuck skeleton.
    const [quotaResult, spendersResult] = await Promise.allSettled([
      sendRuntimeRequest('getAiQuotaByPage'),
      sendRuntimeRequest('getSpendersStatus'),
    ]);
    if (disposed) return;
    const quotaByPage = quotaResult.status === 'fulfilled' ? quotaResult.value : {};
    const spenders = spendersResult.status === 'fulfilled' ? spendersResult.value : null;

    // AI — per page, requests only; NO micro-USD (E14). Empty map = unknown.
    const quotaEntries = quotaByPage && typeof quotaByPage === 'object'
      ? Object.values(quotaByPage)
      : [];
    if (quotaEntries.length === 0) {
      statusRows.ai.set({ badge: 'KERNEL', tone: 'neutral', fact: COPY.status.aiEmpty });
    } else {
      const worst = quotaEntries.reduce<AiQuotaStatus | null>((acc, entry) =>
        acc === null || (entry.remainingRequestsToday ?? Infinity) < (acc.remainingRequestsToday ?? Infinity)
          ? entry : acc, null);
      const remaining = worst?.remainingRequestsToday;
      const tone: BadgeTone = remaining === 0 ? 'bad' : (remaining !== null && remaining !== undefined && remaining <= 20) ? 'amber' : 'green';
      statusRows.ai.set({ badge: 'KERNEL', tone, fact: `${quotaEntries.length} стр.` });
      statusRows.ai.setDetailLines(quotaEntries.map((entry) =>
        entry.remainingRequestsToday === null
          ? `${entry.pageLabel} · лимит не сообщён`
          : `${entry.pageLabel} · осталось ${entry.remainingRequestsToday}`));
    }

    // Spenders — freshest observation → RAMPED / FLAG OFF / NOT ALLOWLISTED / FAIL.
    if (!spenders) {
      statusRows.spenders.set({ badge: 'FLAG OFF', tone: 'neutral', fact: COPY.status.spendersEmpty });
    } else if (spenders.outcome === 'fail') {
      statusRows.spenders.set({ badge: 'FAIL', tone: 'bad', fact: 'последняя сборка доски не удалась' });
    } else {
      const map: Record<SpendersStreamState, { badge: string; tone: BadgeTone; fact: string }> = {
        ramped: { badge: 'RAMPED', tone: 'green', fact: 'данные идут' },
        flag_off: { badge: 'FLAG OFF', tone: 'neutral', fact: 'проекция выключена' },
        not_allowlisted: { badge: 'NOT ALLOWLISTED', tone: 'amber', fact: 'страница не в allowlist' },
        unsupported_platform: { badge: 'FLAG OFF', tone: 'neutral', fact: 'платформа не поддерживается' },
      };
      const view = spenders.streamState ? map[spenders.streamState] : map.flag_off;
      statusRows.spenders.set(view);
    }

    updateReadinessHero(); // Task 8
  };

  // ─── Ordered section registration ───────────────────────────
  // MUST stay immediately before the future-schema barrier block below. Every
  // section is now in the DOM (shell.main → shell.layout → root) BEFORE the
  // barrier's catch-up runs `activateFutureSchemaBarrier(futureSchemaObserved)`,
  // so its one-shot `root.querySelectorAll('input, select, button, textarea')`
  // sweep disables the REAL controls. Move this block after the barrier and a
  // v15 observed during the initial storage read would disable nothing real —
  // the re-entry guard makes that first (empty) sweep the only one. Registration
  // order == nav order == card DOM order == the mount test's expectation.
  shell.addSection('status', statusSection);
  shell.addSection('hub', agencyHubSection);
  shell.addSection('personas', personalitiesSection);
  shell.addSection('accounts', mappingsSection);
  shell.addSection('generation', apiSection);
  shell.addSection('appearance', appearanceSection);
  shell.addSection('version', versionSection);

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
      warning.textContent = `Настройки открыты в более новой версии схемы (v${storedVersion}) — эта вкладка больше не сохраняет изменения. Перезагрузи страницу.`;
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
      warning.textContent = 'Не удалось обновить живой статус аккаунтов — показаны маппинги из локального хранилища';
      warning.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(warning);
    }

    state.knownAccounts.forEach((accountId) => {
      const session = sessionsByAccountId.get(accountId);
      const heading = formatAccountHeading(accountId, session);
      const row = document.createElement('div');
      row.dataset.accountMappingRow = accountId;
      // Four columns: avatar, identity block, select, mapping-info. The amber
      // badge lives INSIDE the identity block, never as a fifth grid child.
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'auto minmax(0, 1fr) minmax(220px, 320px) auto';
      row.style.gap = '12px';
      row.style.alignItems = 'center';
      row.style.padding = '12px';
      row.style.borderRadius = 'var(--chatgoose-radius-card)';
      row.style.background = 'var(--chatgoose-bg2)';
      row.style.border = '1px solid var(--chatgoose-line)';
      // Raw timestamp for the minute ticker; only connected rows have a live
      // capture to age. Disconnected rows keep a static "нет сессии".
      if (session?.connected) {
        row.dataset.captureAt = String(session.lastSeenAt);
      }

      const avatar = document.createElement('div');
      avatar.className = 'chatgoose-avatar';
      avatar.textContent = accountAvatarInitials(heading);

      const label = document.createElement('div');
      label.dataset.role = 'account-identity';
      label.style.display = 'grid';
      label.style.gap = '4px';

      const labelTitle = document.createElement('div');
      labelTitle.textContent = heading;
      labelTitle.style.fontWeight = '600';

      const labelMeta = document.createElement('div');
      labelMeta.textContent = formatAccountMeta(accountId, session);
      labelMeta.style.fontSize = '12px';
      labelMeta.style.color = 'var(--chatgoose-ink-mid)';

      const captureLine = document.createElement('div');
      captureLine.dataset.role = 'capture-status';
      // When the live snapshot failed we never verified the session, so do not
      // render a proven "нет сессии". Show the honest unknown state; no
      // dataset.captureAt is stamped above, so the minute ticker skips it.
      captureLine.textContent = hydrationFailed
        ? 'статус неизвестен'
        : formatCaptureStatus(session);
      captureLine.style.fontSize = '12px';
      captureLine.style.color = 'var(--chatgoose-ink-mid)';

      label.append(labelTitle, labelMeta, captureLine);

      const select = document.createElement('select');
      select.className = 'chatgoose-select';
      select.dataset.accountId = accountId;
      const mappedView = populateMappingSelect(
        select,
        state.accountMappings[accountId] ?? '',
        personalityViews,
      );
      select.addEventListener('change', () => {
        const selectedPersonalityId = select.value || null;
        // Reflect the mapping change on the badge immediately, before the
        // async save round-trips.
        syncAccountAiBadge(select);
        select.disabled = true;
        select.dataset.mappingPending = 'true';
        void (async () => {
          try {
            await saveAccountMapping(accountId, selectedPersonalityId);
            savedFlash.showSaved();
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
            // A fresh mapping can flip step 3 (persona assigned) from open to
            // done, so repaint the hero from the same statusModel + account state.
            updateReadinessHero();
          } catch (error) {
            console.error('Failed to save account mapping', error);
            savedFlash.showError('маппинг не сохранился');
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
      info.textContent = formatMappingInfo(mappedView);

      row.append(avatar, label, select, info);
      // append() first so closest('[data-account-mapping-row]') resolves.
      syncAccountAiBadge(select);
      mappingsTable.append(row);
    });

    if (state.knownAccounts.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Аккаунты не обнаружены — открой fansly.com с аккаунтом модели.';
      empty.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(empty);
    }
  };

  // One ticker for the whole section rewrites every connected row's capture
  // line from its stored timestamp, so a long-open tab does not freeze on
  // "захвачена 5 мин назад". Rebuilds re-query the live DOM, so a single
  // interval survives mapping changes; its teardown is registered below.
  const refreshCaptureLines = (): void => {
    for (const row of mappingsTable.querySelectorAll<HTMLElement>('[data-account-mapping-row]')) {
      const captureAt = row.dataset.captureAt;
      if (!captureAt) {
        continue;
      }
      const captureLine = row.querySelector<HTMLElement>('[data-role="capture-status"]');
      if (!captureLine) {
        continue;
      }
      captureLine.textContent = formatCaptureStatus({
        legacyAccountId: '',
        resolvedAccountId: null,
        username: null,
        displayName: null,
        connected: true,
        lastSeenAt: Number(captureAt),
      });
    }
  };
  const captureTicker = window.setInterval(refreshCaptureLines, 60_000);
  cleanupTasks.push(() => window.clearInterval(captureTicker));

  const hydrateAccountSections = async (): Promise<void> => {
    const result = await sessionsResultPromise;
    if (disposed) {
      return;
    }

    if (!result.ok) {
      console.error('Failed to load Fansly sessions for Settings', result.error);
      renderAccountMappings([], true);
      paintFanslyStatusRow([], true);
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
      paintFanslyStatusRow(result.sessions, false);
    } catch (error) {
      console.error('Failed to refresh account state for Settings', error);
      if (!disposed) {
        renderAccountMappings([], true);
        paintFanslyStatusRow([], true);
      }
    }
  };

  void hydrateAccountSections();
  // The stored-snapshot signature is what mount fires against: the form fields
  // were initialized from `state.settings`, so live == stored right now.
  void hydrateHubStatusRows(storedHubSignature());
  // Local storage.session reads — no hub round-trip, no signature guard.
  void hydrateLocalStatusRows();

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
