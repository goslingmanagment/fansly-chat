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
  createBadge,
  createButton,
  createSection,
  createStatusPill,
  createStatusRow,
  createVersionTag,
  debounce,
  injectStyles,
  inlineField,
  labeledField,
  setStatusPill,
  type BadgeTone,
} from './dom.js';
import { COPY } from './copy.js';
import {
  buildSessionLookup,
  formatAccountHeading,
  formatCaptureStatus,
  shortenAccountId,
} from './sessions.js';
import { OPTIONS_PANES } from '../shared/options-routes.js';
import { createShell, navigateTo } from './shell.js';
import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import {
  createUserError,
  formatUserErrorTechnicalDetail,
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
  AgencyHubDeviceTokenMeta,
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AgencyHubSignOutResponse,
  AiQuotaStatus,
  OpsDailySnapshot,
  PersonaCatalogEntry,
  SessionSnapshotEntry,
  Settings,
  SpendersObservation,
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

const COPY_FEEDBACK_MS = 1400;

// The settings tab has no live session port, so the Fansly row can otherwise
// only close on a full reload. A focus/visibility re-poll closes it in place;
// throttle it so rapid tab-switching cannot storm getSessionsSnapshot.
const SESSIONS_REPOLL_MIN_INTERVAL_MS = 5_000;
// «Проверить всё» re-runs the hub + local reads. It deliberately does NOT touch
// getSessionsSnapshot (whose handler resolves identities against Fansly /me);
// the throttle keeps a jammed button from storming the hub either.
const CHECK_ALL_THROTTLE_MS = 10_000;
/** Below this the quota badge turns amber; at 0 it turns red. */
const AI_QUOTA_LOW_THRESHOLD = 20;

type SessionsResult =
  | { ok: true; sessions: SessionSnapshotEntry[] }
  | { ok: false; error: unknown };

/** A runtime reply is only as trustworthy as its shape. A stale background, a
 * truncated frame or a harness with no handler resolves to something that is
 * NOT the declared type; painting it would fabricate a verdict, so every
 * optional read passes through a guard and falls back to honest-unknown. */
function asOpsDailySnapshot(value: unknown): OpsDailySnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    Array.isArray(record.hubErrors) &&
    typeof record.hubErrorsTotal === 'number'
    ? (value as OpsDailySnapshot)
    : null;
}

function asDeviceTokenMeta(value: unknown): AgencyHubDeviceTokenMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    typeof record.keyPrefix === 'string' &&
    typeof record.issuedAt === 'number'
    ? (value as AgencyHubDeviceTokenMeta)
    : null;
}

function asQuotaEntries(value: unknown): AiQuotaStatus[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).filter(
    (entry): entry is AiQuotaStatus =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as AiQuotaStatus).pageLabel === 'string',
  );
}

function asSpendersObservation(value: unknown): SpendersObservation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return record.outcome === 'ok' || record.outcome === 'fail'
    ? (value as SpendersObservation)
    : null;
}

function formatClockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Everything «Скопировать отчёт» is allowed to know.
 *
 * There is no credential field in this shape and no way to reach one from it:
 * the report is secret-free BY CONSTRUCTION, not by redaction. `hubBaseUrl` is
 * the address the chatter typed (not a secret) and materially helps support;
 * `identity.username` is the Hub login the pane already displays.
 */
interface StatusReportModel {
  version: string;
  schemaVersion: number;
  generatedAt: number;
  hubBaseUrl: string;
  fansly: { accounts: number; handles: string[]; capture: string | null };
  health: AgencyHubHealthResponse | null;
  identity: AgencyHubIdentityResponse | null;
  quotaByPage: AiQuotaStatus[];
  spenders: SpendersObservation | null;
  opsDaily: OpsDailySnapshot | null;
  /** Which LOCAL reads REJECTED. An empty `quotaByPage` and a null `spenders`
   * are ambiguous on their own — they are equally the honest-empty state and
   * the failed-read state — so the failure is carried explicitly. Without it
   * both the rows and the report would print «сегодня генераций не было» about
   * a source nobody managed to read. */
  unavailable: { quota: boolean; opsDaily: boolean; spenders: boolean };
  readiness: Array<{ key: string; label: string; done: boolean }>;
}

/** A plain-text snapshot of this page for a support message. «Неизвестно» is
 * printed as «неизвестно» — the report never upgrades an unknown into a claim. */
export function buildStatusReport(model: StatusReportModel): string {
  const unknown = COPY.common.unknown;
  const lines: string[] = [
    `ChatGoose ${model.version} · storage v${model.schemaVersion}`,
    `${new Date(model.generatedAt).toISOString()}`,
    `Hub URL: ${model.hubBaseUrl || unknown}`,
    '',
  ];

  lines.push(`${COPY.status.fanslyLabel}: ${
    model.fansly.accounts === 0
      ? COPY.status.fanslyEmpty
      : `${model.fansly.accounts} — ${model.fansly.handles.join(', ')}${
          model.fansly.capture ? ` (${model.fansly.capture})` : ''
        }`
  }`);

  const health = model.health;
  lines.push(`${COPY.status.hubLabel}: ${
    health === null
      ? unknown
      : health.ok
        ? `${health.status}${health.dbLatencyMs === null ? '' : ` · db ${health.dbLatencyMs}ms`}`
        : health.reason
  }`);

  const identity = model.identity;
  lines.push(`${COPY.status.accessLabel}: ${
    identity === null
      ? unknown
      : identity.ok
        ? `${identity.username} · ${identity.role} · pages ${identity.pages.length}`
        : identity.reason
  }`);

  lines.push(`${COPY.status.aiLabel}: ${
    model.unavailable.quota
      ? COPY.status.aiUnavailable
      : model.quotaByPage.length === 0
        ? COPY.status.aiEmpty
        : model.quotaByPage
            .map((entry) => `${entry.pageLabel}=${entry.remainingRequestsToday ?? unknown}`)
            .join(', ')
  }`);

  const ops = model.opsDaily;
  lines.push(`${COPY.status.activityLabel}: ${
    model.unavailable.opsDaily
      ? COPY.status.activityUnavailable
      : !ops || !ops.lastGeneration
        ? COPY.status.activityEmpty
        : `${ops.lastGeneration.feature} · ${ops.lastGeneration.pageLabel} · ${
            new Date(ops.lastGeneration.at).toISOString()
          }`
  }`);
  if (ops) {
    lines.push(`${COPY.hub.errorsLabel}: ${ops.hubErrorsTotal}`);
    for (const entry of ops.hubErrors) {
      lines.push(`  ${new Date(entry.at).toISOString()} ${entry.code}`);
    }
  }

  lines.push(`${COPY.status.spendersLabel}: ${
    model.unavailable.spenders
      ? COPY.status.spendersUnavailable
      : model.spenders === null
        ? COPY.status.spendersEmpty
        : `${model.spenders.outcome} · ${model.spenders.streamState ?? unknown}`
  }`);

  lines.push(`${COPY.status.contractLabel}: ${
    health === null || !health.ok
      ? unknown
      : `${health.contractHash === health.sdkContractHash ? 'match' : 'drift'} · core ${
          health.sdkSourceCommit ?? unknown
        }`
  }`);

  lines.push('');
  for (const step of model.readiness) {
    lines.push(`[${step.done ? 'x' : ' '}] ${step.label}`);
  }

  return lines.join('\n');
}

/** The account-id meta line doubles as a copy button (popup discipline). */
function createCopyableId(fullId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chatgoose-copy-id';
  button.title = COPY.accounts.idCopyTitle.replace('{id}', fullId);
  const idText = `${COPY.accounts.idPrefix}${fullId}`;
  button.textContent = idText;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(fullId)
      .then(() => {
        button.classList.add('chatgoose-copy-id-done');
        button.textContent = COPY.accounts.idCopied;
        if (restoreTimer !== undefined) {
          clearTimeout(restoreTimer);
        }
        restoreTimer = setTimeout(() => {
          button.classList.remove('chatgoose-copy-id-done');
          button.textContent = idText;
        }, COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  });
  return button;
}

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

function renderStorageUnavailable(): void {
  root.replaceChildren();
  root.style.paddingBottom = '24px';
  const hero = document.createElement('div');
  hero.style.padding = '28px 20px 4px';
  hero.style.display = 'grid';
  hero.style.gap = '8px';
  const title = document.createElement('h1');
  title.textContent = 'ChatGoose Settings Unavailable';
  const subtitle = document.createElement('div');
  subtitle.textContent = 'Local storage could not be safely prepared. Reload Settings before editing.';
  subtitle.style.color = 'var(--chatgoose-ink-mid)';
  hero.append(createVersionTag(extensionVersion), title, subtitle);
  const reload = createButton('Reload Settings', true);
  reload.addEventListener('click', () => window.location.reload());
  const recovery = createSection(
    'Storage protection',
    'This Settings page did not apply any edits. Reloading wakes the background worker and retries the protected migration.',
  );
  recovery.append(reload);
  root.append(hero, recovery);
}

async function render(): Promise<void> {
  await renderCleanup?.();
  renderCleanup = null;

  const cleanupTasks: Array<() => void> = [];
  let disposed = false;
  let futureSchemaObserved: number | null = null;
  let applyFutureSchemaBarrierToUi: ((storedVersion: number) => void) | null = null;
  // Wall-clock of the last getSessionsSnapshot dispatch (mount or re-poll); the
  // focus/visibility re-poll reads it to enforce the throttle window.
  let lastSessionsPollAt = 0;
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
  // Options is a synchronous writer on pagehide. Before it reads or renders an
  // editable snapshot, wake the MV3 worker and require a DURABLE migration
  // barrier: legacy credentials must already live in their top-level custody
  // keys. An old/failed worker returns no structured acknowledgement, so fail
  // closed instead of risking a secret-stripping current-schema write.
  try {
    const readiness = await sendRuntimeRequest('ensureStorageReady');
    if (readiness?.ready !== true) {
      throw new Error('Background storage readiness was not acknowledged');
    }
  } catch (error) {
    console.error('Failed to prepare Settings storage', error);
    cleanupTasks.forEach((cleanup) => cleanup());
    renderStorageUnavailable();
    return;
  }
  // Start live session discovery immediately, but do not put it on the
  // critical path for the local settings UI. getSessionsSnapshot may spend up
  // to five seconds resolving a Fansly identity. It also owns identity
  // rekey/reconcile, so account controls stay in a loading state until it has
  // finished and we have re-read the resulting storage state.
  const loadSessionsResult = (): Promise<SessionsResult> => {
    lastSessionsPollAt = Date.now();
    return sendRuntimeRequest('getSessionsSnapshot')
      .then((sessions): SessionsResult => (
        Array.isArray(sessions)
          ? { ok: true, sessions }
          : { ok: false, error: new Error('Invalid sessions snapshot response') }
      ))
      .catch((error: unknown): SessionsResult => ({ ok: false, error }));
  };
  const sessionsResultPromise = loadSessionsResult();
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

  // ─── Cabinet frame ─────────────────────────────────────────
  // Panes are built once and shown/hidden; sections below are appended into
  // their pane instead of into the page root. The recovery gates above return
  // before this point — they are deliberately outside the shell.
  // «Хоткеи» enables with its pane content (plan task 12); until then the rail
  // hides the item and a #hotkeys deep link falls back to «Статус».
  const shell = createShell(
    root,
    OPTIONS_PANES.filter((pane) => pane !== 'hotkeys'),
  );
  cleanupTasks.push(() => shell.dispose());

  // ─── Readiness headline ────────────────────────────────────
  // The install's verdict in one line. It derives entirely from the SAME
  // `statusModel` the Статус rows paint from — zero extra requests — and counts
  // ONLY the actionable prerequisites (E41): an unknown quota or an unopened
  // Spenders board is an observation, not a broken install.
  const readinessHero = document.createElement('section');
  readinessHero.className = 'chatgoose-readiness';
  readinessHero.dataset.readinessHero = 'true';
  const readinessHeading = document.createElement('h1');
  readinessHeading.className = 'chatgoose-readiness-heading';
  readinessHeading.textContent = COPY.status.checkingTitle;
  const readinessSub = document.createElement('div');
  readinessSub.className = 'chatgoose-readiness-sub';
  readinessSub.textContent = COPY.status.checkingSubtitle;
  const readinessOpen = document.createElement('ul');
  readinessOpen.className = 'chatgoose-readiness-open';
  readinessOpen.hidden = true;
  readinessHero.append(
    createVersionTag(extensionVersion),
    readinessHeading,
    readinessSub,
    readinessOpen,
  );
  shell.panes.status.append(readinessHero);

  // ─── Appearance ─────────────────────────────────────────────
  const appearanceSection = createSection(
    'Appearance',
    'One family look, light and dark. System follows your OS.',
  );
  const themeChoices: Array<{ value: UiThemeSetting; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];
  const themeControl = document.createElement('div');
  themeControl.className = 'chatgoose-segmented';
  const themeRadios: HTMLInputElement[] = [];
  for (const choice of themeChoices) {
    const segment = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'chatgoose-ui-theme';
    radio.value = choice.value;
    radio.checked = state.settings.uiTheme === choice.value;
    const text = document.createElement('span');
    text.textContent = choice.label;
    segment.append(radio, text);
    themeControl.append(segment);
    themeRadios.push(radio);
  }
  const getSelectedTheme = (): UiThemeSetting =>
    (themeRadios.find((radio) => radio.checked)?.value ?? 'system') as UiThemeSetting;
  // Not inlineField: that wraps in a <label>, and a label around the radio
  // group would nest labels and misroute clicks to the first radio.
  const themeRow = document.createElement('div');
  themeRow.className = 'chatgoose-row';
  const themeRowLabel = document.createElement('span');
  themeRowLabel.className = 'chatgoose-row-label';
  themeRowLabel.textContent = 'Theme';
  themeRow.append(themeRowLabel, themeControl);
  appearanceSection.append(themeRow);

  // ─── Generation settings (Stage 32: keys/models are kernel-side) ────
  const apiSection = createSection('Generation');

  const quickInput = document.createElement('input');
  quickInput.type = 'number';
  quickInput.className = 'chatgoose-input chatgoose-input-num';
  quickInput.min = '5';
  quickInput.max = '200';
  quickInput.value = String(state.settings.quickMessageCount);

  const pingInput = document.createElement('input');
  pingInput.type = 'number';
  pingInput.className = 'chatgoose-input chatgoose-input-num';
  pingInput.min = '5';
  pingInput.max = '200';
  pingInput.value = String(state.settings.pingMessageCount);

  const improveInput = document.createElement('input');
  improveInput.type = 'number';
  improveInput.className = 'chatgoose-input chatgoose-input-num';
  improveInput.min = '5';
  improveInput.max = '200';
  improveInput.value = String(state.settings.improveMessageCount);

  const deepInput = document.createElement('input');
  deepInput.type = 'number';
  deepInput.className = 'chatgoose-input chatgoose-input-num';
  deepInput.min = '100';
  deepInput.max = '3000';
  deepInput.value = String(state.settings.deepMessageCount);

  const coachHistoryInput = document.createElement('input');
  coachHistoryInput.type = 'number';
  coachHistoryInput.className = 'chatgoose-input chatgoose-input-num';
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
  coachRecapWarning.className = 'chatgoose-meta';
  coachRecapWarning.style.flexBasis = '100%';
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

  // The cost warning belongs to the recap row: full-width second line inside it.
  const coachRecapRow = inlineField('Auto-Recap before coaching', coachRecapSelect);
  coachRecapRow.style.flexWrap = 'wrap';
  coachRecapRow.append(coachRecapWarning);

  // Count rows carry their allowed range beside the input; the same hint
  // flashes amber when a save clamps an out-of-range entry.
  const countHints = new Map<HTMLInputElement, HTMLSpanElement>();
  const numberRow = (labelText: string, input: HTMLInputElement): HTMLElement => {
    const hint = document.createElement('span');
    hint.className = 'chatgoose-row-hint';
    hint.textContent = `${input.min}–${input.max}`;
    countHints.set(input, hint);
    const control = document.createElement('span');
    control.className = 'chatgoose-row-control';
    control.append(hint, input);
    // A wheel over a focused number input silently changes the value while
    // the chatter is just scrolling the page — blur keeps the scroll a scroll.
    input.addEventListener('wheel', () => {
      if (document.activeElement === input) {
        input.blur();
      }
    }, { passive: true });
    return inlineField(labelText, control);
  };
  const flashClampHint = (input: HTMLInputElement, value: number): void => {
    const hint = countHints.get(input);
    if (!hint) {
      return;
    }
    hint.textContent = `saved as ${value}`;
    hint.classList.add('chatgoose-row-hint-clamped');
    window.setTimeout(() => {
      hint.textContent = `${input.min}–${input.max}`;
      hint.classList.remove('chatgoose-row-hint-clamped');
    }, 2600);
  };

  const generationRows = document.createElement('div');
  generationRows.className = 'chatgoose-rows';
  generationRows.append(
    numberRow('Reply + Help message count', quickInput),
    numberRow('Ping message count', pingInput),
    numberRow('Fix message count', improveInput),
    numberRow('Deep feature message count', deepInput),
    numberRow('Coach dialog memory (exchanges)', coachHistoryInput),
    coachRecapRow,
    inlineField('Enable debug mode', debugInput),
  );
  apiSection.append(generationRows);

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
  agencyHubPermissionMeta.className = 'chatgoose-meta';

  const agencyHubPermissionButton = createButton(COPY.status.grantAccess, true);
  const agencyHubConnectionStatus = document.createElement('div');

  const agencyHubConnectionMeta = document.createElement('div');
  agencyHubConnectionMeta.className = 'chatgoose-meta';

  const agencyHubConnectionButton = createButton(COPY.hub.testConnection, true);
  const agencyHubActionRow = document.createElement('div');
  agencyHubActionRow.style.display = 'flex';
  agencyHubActionRow.style.gap = '8px';
  agencyHubActionRow.style.flexWrap = 'wrap';
  agencyHubActionRow.append(agencyHubPermissionButton, agencyHubConnectionButton);

  let agencyHubConnectionVersion = 0;
  let lastAgencyHubConnectionSignature: string | null = null;
  /** Assigned by the «Статус» block below; every earlier producer calls it
   * through this hook so nothing depends on declaration order. */
  let renderHubDiagnostics: () => void = () => undefined;
  /** Last live connection test: when, outcome, how long, and WHICH credential
   * carried it. The bearer kind is a LOCAL mirror of the same preference the
   * background applies (device token first, legacy key as fallback) — the
   * connection-test response is deliberately not extended to report it. */
  let lastConnectionCheck: {
    at: number;
    ok: boolean;
    durationMs: number;
    viaDeviceToken: boolean;
    code?: string;
  } | null = null;

  const renderAgencyHubConnectionState = (): void => {
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const hasInputs = hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken);

    agencyHubConnectionButton.disabled =
      agencyHubConnectionFeedback.kind === 'testing' || !hasInputs;

    switch (agencyHubConnectionFeedback.kind) {
      case 'idle':
        setStatusPill(agencyHubConnectionStatus, 'neutral', 'Not tested yet.');
        agencyHubConnectionMeta.textContent = 'Save a Hub URL and API key to run a live connection test.';
        return;
      case 'pending':
        setStatusPill(agencyHubConnectionStatus, 'neutral', 'Connection status updating…');
        agencyHubConnectionMeta.textContent = 'Saving Agency Hub changes before the next live test.';
        return;
      case 'testing':
        setStatusPill(agencyHubConnectionStatus, 'neutral', 'Testing connection…');
        agencyHubConnectionMeta.textContent = 'Checking Hub reachability, permissions, and API key.';
        return;
      case 'connected':
        setStatusPill(agencyHubConnectionStatus, 'ok', 'Connected ✓');
        agencyHubConnectionMeta.textContent = `Live connection test succeeded for ${agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || 'Agency Hub'}.`;
        return;
      case 'failed': {
        const failedError = agencyHubConnectionFeedback.error;
        const description = getUserErrorDescription(failedError);
        setStatusPill(agencyHubConnectionStatus, 'bad', `Connection failed: ${failedError.code}`);
        const technicalDetail = formatUserErrorTechnicalDetail(failedError);
        agencyHubConnectionMeta.textContent = [
          failedError.message,
          description,
          technicalDetail,
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

  // Also assigned below: the pre-sign-out quiesce of that same writer. «Выйти»
  // destroys credentials background-side, and this page's debounced chain writes
  // `agencyHubApiKey` OUTSIDE the auth FIFO — a save that lands during the
  // (up-to-5s) revoke would restore a usable legacy key after the wipe.
  let quiesceSettingsBeforeSignOut: () => Promise<void> = async () => undefined;

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

      // Time only the round trip the hub actually answers — not the local save
      // above, which would inflate the reported latency.
      const startedAt = performance.now();
      const viaDeviceToken = Boolean(state.settings.agencyHubDeviceToken.trim());
      const response = await sendRuntimeRequest('testAgencyHubConnection', {
        settings: {
          agencyHubBaseUrl: agencyHubUrlInput.value,
          agencyHubApiKey: agencyHubKeyInput.value.trim(),
          agencyHubDeviceToken: state.settings.agencyHubDeviceToken,
        },
      });
      const durationMs = Math.round(performance.now() - startedAt);

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
      lastConnectionCheck = {
        at: Date.now(),
        ok: response.ok,
        durationMs,
        viaDeviceToken,
        ...(response.ok ? {} : { code: (response.error ?? createUserError('hub_request_failed')).code }),
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
    renderHubDiagnostics();
  };

  let agencyHubPermissionRefreshVersion = 0;
  /** null = not checked yet (no origin to check). Feeds the «Доступ» step. */
  let hubPermissionGranted: boolean | null = null;
  const refreshAgencyHubPermissionState = async (): Promise<void> => {
    const refreshVersion = ++agencyHubPermissionRefreshVersion;
    // Every early-return branch below is a "Sync disabled" state — amber by
    // default; only the final granted state overrides to green.
    agencyHubPermissionStatus.style.color = 'var(--chatgoose-amber)';
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const originPattern = buildAgencyHubOriginPattern(normalizedBaseUrl);
    const permissionScopeNote = buildAgencyHubPermissionScopeNote(normalizedBaseUrl);
    const hasApiKey = agencyHubKeyInput.value.trim().length > 0 || state.settings.agencyHubDeviceToken.trim().length > 0;
    const permissionCheck = await getAgencyHubPermissionCheck(originPattern);
    const permissionGranted = permissionCheck.granted;

    if (refreshVersion !== agencyHubPermissionRefreshVersion) {
      return;
    }

    // The «Доступ» readiness step reads this local check — the only place that
    // knows whether Firefox granted the hub origin. Forward reference: the
    // status view is defined below and this function only ever runs later.
    hubPermissionGranted = originPattern ? permissionGranted : null;
    refreshStatusView();
    renderHubDiagnostics();

    if (permissionGranted) {
      agencyHubPermissionFeedback = null;
    }

    agencyHubPermissionButton.textContent = permissionGranted
      ? COPY.hub.reconnectAccess
      : COPY.status.grantAccess;
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
    agencyHubPermissionStatus.style.color = 'var(--chatgoose-green)';
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
  const hubSignInMeta = document.createElement('div');
  hubSignInMeta.className = 'chatgoose-meta';

  let hubSignInFormExpanded = false;
  const hubReissueButton = createButton(COPY.hub.reissueToken, true);
  const hubSignOutButton = createButton(COPY.hub.signOut, true);
  const hubSignOutConfirmButton = createButton(COPY.hub.signOut.replace('…', ''), false, true);
  const hubSignOutCancelButton = createButton(COPY.hub.signOutCancel, true);
  const hubSignOutConfirmRow = document.createElement('div');
  hubSignOutConfirmRow.className = 'chatgoose-card-actions';
  const hubSignOutConfirmLabel = document.createElement('span');
  hubSignOutConfirmLabel.textContent = COPY.hub.signOutConfirm;
  hubSignOutConfirmRow.append(
    hubSignOutConfirmLabel,
    hubSignOutConfirmButton,
    hubSignOutCancelButton,
  );
  hubSignOutConfirmRow.hidden = true;
  const hubSignOutStatus = document.createElement('div');
  hubSignOutStatus.className = 'chatgoose-meta';
  hubSignOutStatus.setAttribute('role', 'status');
  hubSignOutStatus.setAttribute('aria-live', 'polite');
  const hubSignOutHint = document.createElement('div');
  hubSignOutHint.className = 'chatgoose-meta';
  hubSignOutHint.textContent = COPY.hub.signOutHint;

  // «Device token» line: pill + which token (its prefix) + when it was issued.
  // The expiry date is deliberately NOT shown — hub expiry slides on every use.
  const hubTokenRow = document.createElement('div');
  hubTokenRow.className = 'chatgoose-status-body';
  hubTokenRow.dataset.hubDetail = 'device-token';
  const hubTokenLabel = document.createElement('span');
  hubTokenLabel.className = 'chatgoose-status-label';
  hubTokenLabel.textContent = COPY.hub.deviceTokenLabel;
  const hubTokenPill = document.createElement('span');
  const hubTokenMeta = document.createElement('span');
  hubTokenMeta.className = 'chatgoose-status-fact';
  hubTokenRow.append(hubTokenLabel, hubTokenPill, hubTokenMeta);

  let deviceTokenMeta: AgencyHubDeviceTokenMeta | null = null;

  const renderHubSignInState = (): void => {
    const hasToken = Boolean(state.settings.agencyHubDeviceToken.trim());
    setStatusPill(
      hubSignInStatus,
      hasToken ? 'ok' : 'neutral',
      hasToken ? 'Device token active ✓' : 'No device token yet.',
    );
    if (!hubSignInMeta.textContent) {
      hubSignInMeta.textContent = hasToken
        ? 'Hub requests use the device token; the legacy API key is the fallback.'
        : 'Sign in once to issue a device-bound token — no more pasting an issued key, and it survives key rotation.';
    }
    // With a live token the credential form reads as unfinished business —
    // fold it away; «Перевыпустить токен» brings it back for rotation.
    // The inline grid display would override [hidden] — set both.
    hubSignInRow.hidden = hasToken && !hubSignInFormExpanded;
    hubSignInRow.style.display = hubSignInRow.hidden ? 'none' : 'grid';
    hubReissueButton.hidden = !hasToken || hubSignInFormExpanded;
    hubSignOutButton.hidden = !hasToken && !state.settings.agencyHubApiKey.trim();
    if (hubSignOutButton.hidden) {
      hubSignOutConfirmRow.hidden = true;
    }

    setStatusPill(
      hubTokenPill,
      hasToken ? 'ok' : 'neutral',
      hasToken ? COPY.hub.deviceTokenActive : COPY.hub.deviceTokenMissing,
    );
    if (!hasToken) {
      hubTokenMeta.textContent = '';
    } else if (deviceTokenMeta) {
      hubTokenMeta.textContent = [
        `${deviceTokenMeta.keyPrefix}…`,
        COPY.hub.deviceTokenIssued.replace(
          '{date}',
          new Date(deviceTokenMeta.issuedAt).toLocaleDateString(),
        ),
        COPY.hub.deviceTokenRenews,
      ].join(' · ');
    } else {
      // A token issued before this version has no recorded metadata. Say that
      // instead of inventing a date.
      hubTokenMeta.textContent = `${COPY.hub.deviceTokenUnknown} · ${COPY.hub.deviceTokenRenews}`;
    }
  };

  hubReissueButton.addEventListener('click', () => {
    hubSignInFormExpanded = true;
    renderHubSignInState();
    hubSignInUserInput.focus();
  });

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
          // The background wrote the token's operational metadata inside the
          // same auth critical section; pull it so the pane can name WHICH
          // token is live without ever reading the token.
          deviceTokenMeta = asDeviceTokenMeta(
            await sendRuntimeRequest('getAgencyHubDeviceTokenMeta').catch(() => null),
          );
          hubSignInPasswordInput.value = '';
          hubSignInFormExpanded = false;
          hubSignInMeta.textContent =
            `Device token ${response.keyPrefix}… issued (expires ${new Date(response.expiresAt).toLocaleDateString()}).`;
          // The fresh token arrived OUTSIDE the save-hook path (direct
          // storage re-read), so the signature-change refresh never fires on
          // its own — without this the diagnostics card and the hero pill
          // keep claiming "not set up" next to an active token.
          void (async () => {
            await refreshAgencyHubPermissionState();
            await runAgencyHubConnectionTest({ force: true });
            // The freshly-issued device token makes checkIdentity return AUTH,
            // so the Доступ row (and the headline) flip in place — no reload.
            await hydrateHubStatusRows(storedHubSignature());
          })().catch((error: unknown) => {
            console.error('Failed to refresh Agency Hub status after sign-in', error);
          });
        } else {
          hubSignInMeta.textContent = `Sign-in failed: ${response.error.message}`;
        }
      } finally {
        hubSignInButton.disabled = false;
        renderHubSignInState();
      }
    })();
  });
  const hubSignInFields = document.createElement('div');
  hubSignInFields.className = 'chatgoose-signin-grid';
  hubSignInFields.append(hubSignInUserInput, hubSignInPasswordInput);
  const hubSignInRow = document.createElement('div');
  hubSignInRow.style.display = 'grid';
  hubSignInRow.style.gap = '8px';
  hubSignInButton.style.justifySelf = 'start';
  hubSignInRow.append(hubSignInFields, hubSignInButton);
  // «Выйти…» is two-step on purpose: it destroys credentials on this device.
  hubSignOutButton.addEventListener('click', () => {
    hubSignOutConfirmRow.hidden = false;
    hubSignOutButton.hidden = true;
    hubSignOutStatus.textContent = '';
  });
  hubSignOutCancelButton.addEventListener('click', () => {
    hubSignOutConfirmRow.hidden = true;
    renderHubSignInState();
  });
  hubSignOutConfirmButton.addEventListener('click', () => {
    void (async () => {
      hubSignOutConfirmButton.disabled = true;
      hubSignOutCancelButton.disabled = true;
      hubSignOutStatus.textContent = COPY.hub.signOutRunning;
      // Quiesce this page's settings writer FIRST. A debounced snapshot still
      // pending here carries `agencyHubApiKey`, and letting it land during the
      // background's revoke window would resurrect a usable key after the wipe
      // — the handler would then honestly report `revoked` about a credential
      // that is back on disk. Cancel the pending write and join any already-
      // running one before the wipe begins.
      await quiesceSettingsBeforeSignOut();
      if (disposed) return;
      // The background owns the whole sequence — capture, wipe, revoke — so a
      // pagehide mid-revoke can never leave the credentials on disk. The token
      // never crosses this boundary; only the outcome does.
      let outcome: AgencyHubSignOutResponse;
      try {
        outcome = await sendRuntimeRequest('signOutAgencyHub');
      } catch (error) {
        // A rejected request means the background may have wiped NOTHING.
        // Report the loud case, never a comforting «стёрт локально».
        console.error('Agency Hub sign-out request failed', error);
        outcome = { outcome: 'wipe-failed' };
      }
      if (disposed) return;

      // Re-read storage as the source of truth about what is actually stored
      // now — including the wipe-failed case, where the fields must show what
      // really survived rather than an optimistic blank.
      try {
        state.settings = (await loadStorageState()).settings;
      } catch (error) {
        console.error('Failed to re-read settings after sign-out', error);
      }
      deviceTokenMeta = asDeviceTokenMeta(
        await sendRuntimeRequest('getAgencyHubDeviceTokenMeta').catch(() => null),
      );
      agencyHubApiKeyDirty = false;
      agencyHubKeyInput.value = state.settings.agencyHubApiKey;

      hubSignOutStatus.textContent = {
        revoked: COPY.hub.signOutRevoked,
        'already-invalid': COPY.hub.signOutAlreadyInvalid,
        unreachable: COPY.hub.signOutUnreachable,
        'wipe-failed': COPY.hub.signOutWipeFailed,
      }[outcome.outcome];
      hubSignOutStatus.dataset.signOutOutcome = outcome.outcome;

      hubSignOutConfirmButton.disabled = false;
      hubSignOutCancelButton.disabled = false;
      hubSignOutConfirmRow.hidden = true;
      hubSignInMeta.textContent = '';
      renderHubSignInState();
      // The credential is gone: repaint the hub-facing diagnosis rather than
      // leaving an AUTH row next to an empty token field.
      void (async () => {
        await refreshAgencyHubPermissionState();
        await runAgencyHubConnectionTest({ force: true });
        await hydrateHubStatusRows(storedHubSignature());
      })().catch((error: unknown) => {
        console.error('Failed to refresh Agency Hub status after sign-out', error);
      });
    })();
  });

  const hubSignInWrap = document.createElement('div');
  hubSignInWrap.style.display = 'grid';
  hubSignInWrap.style.gap = '8px';
  hubReissueButton.style.justifySelf = 'start';
  const hubTokenActions = document.createElement('div');
  hubTokenActions.className = 'chatgoose-card-actions';
  hubTokenActions.append(hubReissueButton, hubSignOutButton);
  hubSignInWrap.append(
    hubSignInRow,
    hubTokenRow,
    hubTokenActions,
    hubSignOutConfirmRow,
    hubSignOutStatus,
    hubSignOutHint,
  );
  renderHubSignInState();

  const agencyHubStatusDivider = document.createElement('div');
  agencyHubStatusDivider.className = 'chatgoose-card-divider';
  const agencyHubStatusCard = document.createElement('div');
  agencyHubStatusCard.className = 'chatgoose-card';
  agencyHubStatusCard.append(
    agencyHubPermissionStatus,
    agencyHubPermissionMeta,
    agencyHubStatusDivider,
    agencyHubConnectionStatus,
    agencyHubConnectionMeta,
    agencyHubActionRow,
  );
  // The device token is the main path (E9d) — the legacy key stays reachable
  // but folded, open only when one is actually stored.
  const legacyKeyDetails = document.createElement('details');
  legacyKeyDetails.className = 'chatgoose-details';
  legacyKeyDetails.open = Boolean(state.settings.agencyHubApiKey.trim());
  const legacyKeySummary = document.createElement('summary');
  legacyKeySummary.textContent = COPY.hub.legacyKeyFold;
  legacyKeyDetails.append(
    legacyKeySummary,
    labeledField('Agency Hub API key (legacy fallback)', agencyHubKeyRow),
  );

  // ── Hub diagnostics: dense, always-visible facts about THIS connection ──
  // Unlike the «Статус» pane's Контракт row (debug-only), every line here is
  // shown unconditionally: this card exists to be pasted into a support thread.
  const hubDetailRow = (label: string, key: string): { root: HTMLElement; value: HTMLElement } => {
    const root = document.createElement('div');
    root.className = 'chatgoose-status-body';
    root.dataset.hubDetail = key;
    const labelNode = document.createElement('span');
    labelNode.className = 'chatgoose-status-label';
    labelNode.textContent = label;
    const value = document.createElement('span');
    value.className = 'chatgoose-status-fact';
    value.textContent = COPY.common.unknown;
    root.append(labelNode, value);
    return { root, value };
  };

  const hubIdentityRow = hubDetailRow(COPY.hub.identityLabel, 'identity');
  const hubPagesRow = hubDetailRow(COPY.hub.pagesLabel, 'pages');
  const hubPagesChips = document.createElement('span');
  hubPagesChips.className = 'chatgoose-hub-chips';
  hubPagesRow.root.append(hubPagesChips);
  const hubConnectionCard = document.createElement('div');
  hubConnectionCard.className = 'chatgoose-card';
  hubConnectionCard.append(hubIdentityRow.root, hubPagesRow.root);

  const hubCheckRow = hubDetailRow(COPY.hub.checkLabel, 'check');
  const hubHostAccessRow = hubDetailRow(COPY.hub.hostAccessLabel, 'host-access');
  const hubContractRow = hubDetailRow(COPY.hub.contractLabel, 'contract');
  const hubErrorsRow = hubDetailRow(COPY.hub.errorsLabel, 'errors');
  const hubFanSummaryRow = hubDetailRow(COPY.hub.fanSummaryLabel, 'fan-summary');
  const hubDiagnosticsCard = document.createElement('div');
  hubDiagnosticsCard.className = 'chatgoose-card';
  hubDiagnosticsCard.dataset.hubDiagnostics = 'true';
  hubDiagnosticsCard.append(
    hubCheckRow.root,
    hubHostAccessRow.root,
    hubContractRow.root,
    hubErrorsRow.root,
    hubFanSummaryRow.root,
    legacyKeyDetails,
  );

  agencyHubSection.append(
    labeledField('Agency Hub base URL', agencyHubUrlInput),
    labeledField('Sign in (device token)', hubSignInWrap),
    hubSignInStatus,
    hubSignInMeta,
    hubConnectionCard,
    agencyHubStatusCard,
    hubDiagnosticsCard,
  );

  // ─── «Статус»: read-only state rows ────────────────────────
  const statusSection = createSection(COPY.sections.statusTitle, COPY.sections.statusHint);
  const statusRows = {
    fansly: createStatusRow(COPY.status.fanslyLabel, 'fansly'),
    hub: createStatusRow(COPY.status.hubLabel, 'hub'),
    access: createStatusRow(COPY.status.accessLabel, 'access'),
    ai: createStatusRow(COPY.status.aiLabel, 'ai'),
    activity: createStatusRow(COPY.status.activityLabel, 'activity'),
    spenders: createStatusRow(COPY.status.spendersLabel, 'spenders'),
    contract: createStatusRow(COPY.status.contractLabel, 'contract'),
  };
  for (const row of Object.values(statusRows)) row.skeleton();
  // The Контракт row is debug-only here (the Hub pane shows it unconditionally
  // — E59 amendment). It still hydrates, so toggling debug and reloading shows
  // a live value rather than a stale one.
  if (!state.settings.debugMode) statusRows.contract.root.hidden = true;

  const checkAllButton = createButton(COPY.status.checkAll, true);
  const copyReportButton = createButton(COPY.status.copyReport, true);
  const statusActions = document.createElement('div');
  statusActions.className = 'chatgoose-status-actions';
  statusActions.append(checkAllButton, copyReportButton);
  const statusActionNote = document.createElement('div');
  statusActionNote.className = 'chatgoose-status-hint';
  statusActionNote.setAttribute('role', 'status');
  statusActionNote.setAttribute('aria-live', 'polite');
  const statusReportHint = document.createElement('div');
  statusReportHint.className = 'chatgoose-status-hint';
  statusReportHint.textContent = COPY.status.reportHint;

  statusSection.append(
    statusRows.fansly.root,
    statusRows.hub.root,
    statusRows.access.root,
    statusRows.ai.root,
    statusRows.activity.root,
    statusRows.spenders.root,
    statusRows.contract.root,
    statusActions,
    statusActionNote,
    statusReportHint,
  );
  shell.panes.status.append(statusSection);

  // The single read-only model the rows, the readiness headline and the support
  // report all paint from. Nothing here is a credential: the report is
  // secret-free BY CONSTRUCTION, not by filtering.
  const statusModel: StatusReportModel = {
    version: extensionVersion,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    generatedAt: 0,
    hubBaseUrl: normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl),
    fansly: { accounts: 0, handles: [], capture: null },
    health: null,
    identity: null,
    quotaByPage: [],
    spenders: null,
    opsDaily: null,
    unavailable: { quota: false, opsDaily: false, spenders: false },
    readiness: [],
  };
  // The account ids that currently have a CAPTURED session. The persona step
  // reads only this set, never every knownAccount: an offline historical
  // account with an archived mapping must not block «Готово к смене».
  let capturedAccountIds: string[] = [];
  // Until the first real datum lands — a hub identity read OR the Fansly row
  // painting — the headline stays «Проверяем…» instead of inventing a verdict.
  let fanslyRowPainted = false;

  const isAccountPersonaMapped = (accountId: string): boolean => {
    const mappedKey = state.accountMappings[accountId] ?? '';
    return Boolean(mappedKey) && state.personaCatalog.some(
      (persona) => persona.key === mappedKey && persona.status === 'active',
    );
  };

  const pluralizeActions = (count: number): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return COPY.status.actionWordOne;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return COPY.status.actionWordFew;
    return COPY.status.actionWordMany;
  };

  /**
   * Readiness aggregate — ACTIONABLE prerequisites only (E41). An unknown AI
   * quota, an unopened Spenders board and a quiet day are OBSERVATIONS: they
   * describe the install, they do not block a shift, and they must never turn
   * the headline red.
   */
  const buildReadiness = (): StatusReportModel['readiness'] => [
    { key: 'hub', label: COPY.status.stepHub, done: statusModel.identity?.ok === true },
    {
      key: 'access',
      label: COPY.status.stepAccess,
      // Only a definite `false` is an open step; `null` means «not checked yet»
      // (no hub address entered), which the hub step already covers.
      done: hubPermissionGranted !== false,
    },
    { key: 'fansly', label: COPY.status.stepFansly, done: capturedAccountIds.length > 0 },
    {
      key: 'persona',
      label: COPY.status.stepPersona,
      done: capturedAccountIds.length > 0 &&
        capturedAccountIds.every((accountId) => isAccountPersonaMapped(accountId)),
    },
  ];

  // The Hub pane's dense diagnostics. Everything it shows comes from the SAME
  // statusModel the Статус rows use plus the local connection/permission
  // mirrors — no extra requests, and no line invented when its source is
  // unknown.
  renderHubDiagnostics = (): void => {
    if (disposed) return;

    // Аккаунт + Страницы ядра (identity)
    const identity = statusModel.identity;
    if (identity?.ok) {
      hubIdentityRow.value.textContent = `${identity.username} · ${identity.role}`;
      hubPagesRow.value.textContent = COPY.hub.pagesCount.replace(
        '{n}',
        String(identity.pages.length),
      );
      // Four chips, then an honest «и ещё N» — a chatter on twelve pages must
      // not get a wall of chips.
      const shown = identity.pages.slice(0, 4);
      const chips = shown.map((page) => createBadge(page, 'neutral', true));
      if (identity.pages.length > shown.length) {
        chips.push(
          createBadge(
            COPY.hub.pagesMore.replace('{n}', String(identity.pages.length - shown.length)),
            'neutral',
          ),
        );
      }
      hubPagesChips.replaceChildren(...chips);
    } else {
      hubIdentityRow.value.textContent = identity === null
        ? COPY.common.unknown
        : COPY.status.accessEmpty;
      hubPagesRow.value.textContent = COPY.common.unknown;
      hubPagesChips.replaceChildren();
    }

    // Проверка — when, outcome, how long, and which credential carried it.
    if (!lastConnectionCheck) {
      hubCheckRow.value.textContent = COPY.hub.checkNever;
    } else {
      hubCheckRow.value.textContent = [
        formatClockTime(lastConnectionCheck.at),
        lastConnectionCheck.ok
          ? COPY.hub.checkSuccess
          : `${COPY.hub.checkFailure}${lastConnectionCheck.code ? ` ${lastConnectionCheck.code}` : ''}`,
        `${lastConnectionCheck.durationMs} ms`,
        lastConnectionCheck.viaDeviceToken
          ? COPY.hub.checkViaDeviceToken
          : COPY.hub.checkViaLegacyKey,
      ].join(' · ');
    }

    // Доступ к хосту
    const originPattern = buildAgencyHubOriginPattern(
      normalizeAgencyHubBaseUrl(agencyHubUrlInput.value),
    );
    hubHostAccessRow.value.textContent = hubPermissionGranted === null || !originPattern
      ? COPY.common.unknown
      : hubPermissionGranted
        ? `${COPY.hub.hostAccessGrantedFor} ${originPattern}`
        : COPY.status.hubNoPermission;

    // Контракт SDK — ALWAYS visible here (the Статус row stays debug-only).
    const health = statusModel.health;
    if (health?.ok) {
      const match = health.contractHash === health.sdkContractHash;
      hubContractRow.value.textContent = [
        match ? COPY.hub.contractMatches : COPY.hub.contractMismatch,
        health.contractHash.slice(0, 12),
        ...(health.sdkSourceCommit
          ? [COPY.status.contractSourceCommit.replace('{commit}', health.sdkSourceCommit.slice(0, 12))]
          : []),
      ].join(' · ');
    } else {
      hubContractRow.value.textContent = COPY.status.contractUnknown;
    }

    // Ошибки генераций (Hub) — today's exact count; the list is capped at 20,
    // so say so rather than let «за сегодня: 37» look like 37 listed rows.
    const ops = statusModel.opsDaily;
    if (!ops) {
      hubErrorsRow.value.textContent = COPY.common.unknown;
    } else {
      const last = ops.hubErrors[ops.hubErrors.length - 1];
      hubErrorsRow.value.textContent = [
        COPY.hub.errorsToday.replace('{n}', String(ops.hubErrorsTotal)),
        ...(last
          ? [COPY.hub.errorsLast
              .replace('{code}', last.code)
              .replace('{time}', formatClockTime(last.at))]
          : []),
        ...(ops.hubErrorsTotal > ops.hubErrors.length ? [COPY.hub.errorsCapped] : []),
      ].join(' · ');
    }

    // Fan Summary — the last push that LANDED, honest-empty otherwise.
    const push = ops?.lastSummaryPush ?? null;
    hubFanSummaryRow.value.textContent = !ops
      ? COPY.common.unknown
      : push
        ? COPY.hub.fanSummaryLast
            .replace('{when}', formatClockTime(push.at))
            .replace('{account}', push.accountLabel || COPY.common.unknown)
        : COPY.hub.fanSummaryEmpty;
  };

  const refreshStatusView = (): void => {
    if (disposed) return;
    renderHubDiagnostics();
    // No datum at all yet: keep the honest loading line — never a fabricated
    // «Нужно N действий» over an install nobody has looked at.
    if (statusModel.identity === null && !fanslyRowPainted) {
      readinessHero.dataset.heroState = 'loading';
      readinessHeading.textContent = COPY.status.checkingTitle;
      readinessSub.textContent = COPY.status.checkingSubtitle;
      readinessOpen.replaceChildren();
      readinessOpen.hidden = true;
      shell.setMicro('status', null);
      return;
    }

    const readiness = buildReadiness();
    statusModel.readiness = readiness;
    const open = readiness.filter((step) => !step.done);

    if (open.length === 0) {
      readinessHero.dataset.heroState = 'ready';
      readinessHeading.textContent = COPY.status.readyTitle;
      readinessSub.textContent = COPY.status.readySubtitle;
      readinessOpen.replaceChildren();
      readinessOpen.hidden = true;
    } else {
      readinessHero.dataset.heroState = 'route';
      readinessHeading.textContent = open.length === 1
        ? COPY.status.actionNeededTitle
        : COPY.status.actionsNeededTitle
            .replace('{n}', String(open.length))
            .replace('{word}', pluralizeActions(open.length));
      readinessSub.textContent = COPY.sections.statusHint;
      readinessOpen.replaceChildren(
        ...open.map((step) => {
          const item = document.createElement('li');
          item.dataset.readinessStep = step.key;
          item.textContent = step.label;
          return item;
        }),
      );
      readinessOpen.hidden = false;
    }

    const micro = document.createElement('span');
    micro.className = open.length === 0
      ? 'chatgoose-cabinet-micro-ok'
      : 'chatgoose-cabinet-micro-setup';
    micro.textContent = open.length === 0 ? COPY.rail.microOk : COPY.rail.microSetup;
    shell.setMicro('status', micro);
  };

  const paintFanslyStatusRow = (
    sessions: SessionSnapshotEntry[],
    failed: boolean,
  ): void => {
    // Either branch paints a real Fansly state — enough to lift the headline out
    // of its loading line even before the hub identity read lands.
    fanslyRowPainted = true;
    if (failed) {
      capturedAccountIds = [];
      statusModel.fansly = { accounts: 0, handles: [], capture: null };
      statusRows.fansly.set({
        badge: '—',
        tone: 'neutral',
        fact: COPY.status.fanslyUnavailable,
      });
      refreshStatusView();
      return;
    }
    const lookup = buildSessionLookup(sessions);
    capturedAccountIds = state.knownAccounts.filter(
      (accountId) => lookup.get(accountId)?.connected === true,
    );
    const captured = capturedAccountIds
      .map((accountId) => lookup.get(accountId))
      .filter((session): session is SessionSnapshotEntry => Boolean(session));
    const freshest = [...captured].sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
    const handles = capturedAccountIds.map(
      (accountId) => formatAccountHeading(accountId, lookup.get(accountId)),
    );
    statusModel.fansly = {
      accounts: capturedAccountIds.length,
      handles,
      capture: freshest ? formatCaptureStatus(freshest) : null,
    };

    if (capturedAccountIds.length === 0) {
      statusRows.fansly.set({ badge: '0', tone: 'amber', fact: COPY.status.fanslyEmpty });
    } else {
      statusRows.fansly.set({
        badge: String(capturedAccountIds.length),
        tone: 'green',
        fact: `${COPY.status.fanslyWorking} ${handles.join(', ')}`,
        detail: formatCaptureStatus(freshest),
      });
    }
    refreshStatusView();
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
  // the permission grant and «Проверить всё» pass as their expected snapshot (no
  // unsaved edit is in play at those moments; the form equals stored). The
  // post-persist caller instead passes its own freshly-computed signature.
  const storedHubSignature = (): string =>
    buildAgencyHubConnectionSignature(
      state.settings.agencyHubBaseUrl,
      state.settings.agencyHubApiKey,
      state.settings.agencyHubDeviceToken,
    );
  // Monotonic run id: a newer run bumps it, so an older same-signature run that
  // resolves out of order drops its paint.
  let agencyHubHydrationRun = 0;

  const hydrateHubStatusRows = async (expectedSignature: string): Promise<void> => {
    const run = ++agencyHubHydrationRun;
    // (1) Delayed-START guard — BEFORE issuing any request. If the live form has
    // already moved on from the snapshot this run was fired for, skip entirely:
    // the user is mid-edit and a newer persist will re-trigger with its own
    // signature. Firing a doomed pair of hub requests here is the storm we avoid.
    if (disposed || currentHubSignature() !== expectedSignature) return;
    for (const row of [statusRows.hub, statusRows.access]) row.skeleton();
    // Independent sources: a rejected transport on ONE read must not leave the
    // OTHER row a skeleton nor surface as an unhandled rejection. allSettled
    // lets each row render its own honest state.
    const [healthResult, identityResult] = await Promise.allSettled([
      sendRuntimeRequest('getAgencyHubHealth'),
      sendRuntimeRequest('getAgencyHubIdentity'),
    ]);
    // (2) In-flight guard — re-check before PAINTING. The reads pull SAVED
    // settings background-side, so a paint is only valid while the live form
    // still equals the persisted snapshot this run fired for; a mid-flight edit
    // drops the result (that edit's own persist re-runs hydration). The run id
    // additionally drops a same-signature run a newer run has superseded.
    if (disposed || run !== agencyHubHydrationRun || currentHubSignature() !== expectedSignature) {
      return;
    }
    // A fulfilled read still has to be a well-formed response — a transport that
    // resolves `undefined` (a harness with no handler, a truncated frame) is a
    // failure, never invented into a verdict: fall to honest «unreachable».
    const isOkResponse = (value: unknown): value is { ok: boolean } =>
      typeof value === 'object' && value !== null && 'ok' in value;
    const health: AgencyHubHealthResponse =
      healthResult.status === 'fulfilled' && isOkResponse(healthResult.value)
        ? healthResult.value
        : { ok: false, reason: 'unreachable' };
    const identity: AgencyHubIdentityResponse =
      identityResult.status === 'fulfilled' && isOkResponse(identityResult.value)
        ? identityResult.value
        : { ok: false, reason: 'unreachable' };
    statusModel.health = health;
    statusModel.identity = identity;

    // Hub
    statusRows.hub.setAction(null);
    if (health.ok) {
      statusRows.hub.set({
        badge: health.status === 'degraded' ? 'DEGRADED' : 'UP',
        tone: health.status === 'degraded' ? 'amber' : 'green',
        fact: health.status === 'degraded' ? COPY.status.hubDegraded : COPY.status.hubUp,
        detail: health.dbLatencyMs === null
          ? undefined
          : COPY.status.hubDbLatency.replace('{n}', String(health.dbLatencyMs)),
      });
    } else if (health.reason === 'no_base_url') {
      statusRows.hub.set({ badge: '—', tone: 'neutral', fact: COPY.status.hubEmpty });
    } else if (health.reason === 'no_permission') {
      // A fresh install has no host permission (permissions.contains defaults
      // false) — that is NOT a down core. Distinct amber badge + a grant action
      // routed to the Hub pane, so the renderer never falls through to a false
      // red «ядро недоступно».
      statusRows.hub.set({
        badge: 'НЕТ ДОСТУПА',
        tone: 'amber',
        fact: COPY.status.hubNoPermission,
      });
      const grant = createButton(COPY.status.grantAccess, true);
      grant.addEventListener('click', () => navigateTo('hub'));
      statusRows.hub.setAction(grant);
    } else {
      statusRows.hub.set({ badge: 'DOWN', tone: 'bad', fact: COPY.status.hubDown });
    }

    // Доступ — CREDENTIAL validity only, never a hub-health verdict.
    statusRows.access.setAction(null);
    if (identity.ok) {
      statusRows.access.set({
        badge: 'AUTH',
        tone: 'green',
        fact: `${identity.username} · ${identity.role}`,
        detail: COPY.hub.pagesCount.replace('{n}', String(identity.pages.length)),
      });
    } else if (identity.reason === 'unauthorized') {
      statusRows.access.set({ badge: '401', tone: 'bad', fact: COPY.status.accessRejected });
      const reLogin = createButton(COPY.status.reLogin, true);
      reLogin.addEventListener('click', () => navigateTo('hub'));
      statusRows.access.setAction(reLogin);
    } else if (identity.reason === 'no_credential') {
      statusRows.access.set({ badge: '—', tone: 'neutral', fact: COPY.status.accessEmpty });
    } else if (identity.reason === 'no_base_url') {
      // A credential is present but the hub address is blank — nothing is wrong
      // with the credential, so the badge stays neutral and the fact names the
      // real gap (the missing address), not a false «нет credential».
      statusRows.access.set({ badge: '—', tone: 'neutral', fact: COPY.status.hubEmpty });
    } else {
      // no_permission and unreachable are HUB-health conditions, not credential
      // verdicts — the Доступ badge stays neutral (the blocker is surfaced on
      // the Hub row), never a red «нет credential».
      statusRows.access.set({ badge: '—', tone: 'neutral', fact: COPY.status.accessUnknown });
    }

    // Контракт (debug-only here; derived from the same health response)
    if (health.ok) {
      const match = health.contractHash === health.sdkContractHash;
      statusRows.contract.set({
        badge: match ? 'MATCH' : 'DRIFT',
        tone: match ? 'green' : 'bad',
        fact: match ? COPY.status.contractMatches : COPY.status.contractDrift,
        detail: health.sdkSourceCommit
          ? COPY.status.contractSourceCommit.replace('{commit}', health.sdkSourceCommit.slice(0, 12))
          : undefined,
      });
    } else {
      statusRows.contract.set({ badge: '—', tone: 'neutral', fact: COPY.status.contractUnknown });
    }

    refreshStatusView();
  };

  const hydrateLocalStatusRows = async (): Promise<void> => {
    // Independent sources again: one rejected local read must not strand a
    // sibling row as a skeleton or raise an unhandled rejection.
    const [quotaResult, spendersResult, opsResult] = await Promise.allSettled([
      sendRuntimeRequest('getAiQuotaByPage'),
      sendRuntimeRequest('getSpendersStatus'),
      sendRuntimeRequest('getOpsDaily'),
    ]);
    if (disposed) return;
    // A rejected read is NOT an empty one. `[]` and `null` are what these
    // sources honestly look like on a quiet day, so falling back to them after a
    // transport failure would have the pane assert «сегодня генераций не было»
    // and «доска ещё не открывалась» about state nobody could read. Each read
    // carries its own failure flag into the row AND into the support report.
    const quotaUnavailable = quotaResult.status === 'rejected';
    const spendersUnavailable = spendersResult.status === 'rejected';
    const opsUnavailable = opsResult.status === 'rejected';
    statusModel.unavailable = {
      quota: quotaUnavailable,
      opsDaily: opsUnavailable,
      spenders: spendersUnavailable,
    };
    const spenders = spendersResult.status === 'fulfilled'
      ? asSpendersObservation(spendersResult.value)
      : null;
    const opsDaily = opsResult.status === 'fulfilled'
      ? asOpsDailySnapshot(opsResult.value)
      : null;

    // Квота AI — requests per page only; NEVER a micro-USD figure (E14). An
    // empty map is «no observation today», not «no quota».
    const quotaEntries = quotaResult.status === 'fulfilled'
      ? asQuotaEntries(quotaResult.value)
      : [];
    // Worst first: a page at 0 is what the chatter needs to see, not an average.
    const worstFirst = [...quotaEntries].sort(
      (left, right) =>
        (left.remainingRequestsToday ?? Number.POSITIVE_INFINITY) -
        (right.remainingRequestsToday ?? Number.POSITIVE_INFINITY),
    );
    statusModel.quotaByPage = worstFirst;
    if (quotaUnavailable) {
      // `set` also clears any detail lines a previous successful read painted —
      // per-page numbers under an «недоступно» fact would be stale.
      statusRows.ai.set({ badge: '—', tone: 'neutral', fact: COPY.status.aiUnavailable });
    } else if (worstFirst.length === 0) {
      statusRows.ai.set({ badge: '—', tone: 'neutral', fact: COPY.status.aiEmpty });
    } else {
      const remaining = worstFirst[0]?.remainingRequestsToday ?? null;
      let tone: BadgeTone;
      let fact: string;
      if (remaining === null) {
        // No numeric cap reported for the worst page — a green badge would claim
        // headroom nobody observed. Stay neutral and say the limit is unknown.
        // Its own COPY key, never `aiNoLimit` with the page prefix cut off: the
        // row's subject is already the page, and string surgery on a template
        // breaks silently the first time the phrasing changes.
        tone = 'neutral';
        fact = COPY.status.aiNoLimitPageless;
      } else if (remaining === 0) {
        tone = 'bad';
        fact = COPY.status.aiExhausted;
      } else {
        tone = remaining <= AI_QUOTA_LOW_THRESHOLD ? 'amber' : 'green';
        fact = COPY.status.aiByPageNote;
      }
      statusRows.ai.set({ badge: remaining === null ? '—' : String(remaining), tone, fact });
      statusRows.ai.setDetailLines(worstFirst.map((entry) => (
        entry.remainingRequestsToday === null
          ? COPY.status.aiNoLimit.replace('{page}', entry.pageLabel)
          : COPY.status.aiRemaining
              .replace('{page}', entry.pageLabel)
              .replace('{n}', String(entry.remainingRequestsToday))
      )));
    }

    // Активность — today's accepted generations, straight from the ops-daily
    // counters. No generation today is an OBSERVATION, not a fault.
    statusModel.opsDaily = opsDaily;
    const lastGeneration = opsDaily?.lastGeneration ?? null;
    if (opsUnavailable) {
      // «Сегодня генераций не было» is a claim about the day; a failed read
      // cannot make it. Say the row could not be read instead.
      statusRows.activity.set({
        badge: '—',
        tone: 'neutral',
        fact: COPY.status.activityUnavailable,
      });
    } else if (!lastGeneration) {
      statusRows.activity.set({ badge: '—', tone: 'neutral', fact: COPY.status.activityEmpty });
      statusRows.activity.setDetailLines(
        opsDaily && opsDaily.hubErrorsTotal > 0
          ? [COPY.status.activityHubErrors.replace('{n}', String(opsDaily.hubErrorsTotal))]
          : [],
      );
    } else {
      const label = lastGeneration.accountLabel || shortenAccountId(lastGeneration.accountId);
      statusRows.activity.set({
        badge: formatClockTime(lastGeneration.at),
        tone: 'neutral',
        fact: `${lastGeneration.feature} · ${label}`,
      });
      statusRows.activity.setDetailLines([
        COPY.accounts.corePage.replace('{page}', lastGeneration.pageLabel),
        ...(opsDaily && opsDaily.hubErrorsTotal > 0
          ? [COPY.status.activityHubErrors.replace('{n}', String(opsDaily.hubErrorsTotal))]
          : []),
      ]);
    }

    // Spenders — freshest board observation. A null observation is «not yet
    // observed», NOT «flag off»: inventing FLAG OFF would claim the projection
    // is disabled when nobody has ever looked.
    statusModel.spenders = spenders;
    if (spendersUnavailable) {
      // Not «доска ещё не открывалась» — that would blame the chatter for a
      // read this page failed to make.
      statusRows.spenders.set({
        badge: '—',
        tone: 'neutral',
        fact: COPY.status.spendersUnavailable,
      });
    } else if (!spenders) {
      statusRows.spenders.set({ badge: '—', tone: 'neutral', fact: COPY.status.spendersEmpty });
    } else if (spenders.outcome === 'fail') {
      statusRows.spenders.set({ badge: 'FAIL', tone: 'bad', fact: COPY.status.spendersFail });
    } else {
      const byState: Record<SpendersStreamState, { badge: string; tone: BadgeTone; fact: string }> = {
        ramped: { badge: 'RAMPED', tone: 'green', fact: COPY.status.spendersRamped },
        flag_off: { badge: 'FLAG OFF', tone: 'neutral', fact: COPY.status.spendersFlagOff },
        not_allowlisted: {
          badge: 'NOT ALLOWLISTED',
          tone: 'amber',
          fact: COPY.status.spendersNotAllowlisted,
        },
        unsupported_platform: {
          badge: 'FLAG OFF',
          tone: 'neutral',
          fact: COPY.status.spendersUnsupported,
        },
      };
      // FLAG OFF only from a real flag_off observation; a null streamState on a
      // successful outcome is «not yet observed», so keep the neutral em-dash.
      statusRows.spenders.set(
        spenders.streamState
          ? byState[spenders.streamState]
          : { badge: '—', tone: 'neutral', fact: COPY.status.spendersEmpty },
      );
    }

    refreshStatusView();
  };

  // «Проверить всё» re-runs the hub reads and the local reads — and NOTHING
  // else. getSessionsSnapshot stays out of it on purpose: its handler resolves
  // unknown identities against Fansly's own /me, and a settings button must
  // never become an out-of-band Fansly request (DP 1-B / egress rule).
  let lastCheckAllAt = 0;
  checkAllButton.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastCheckAllAt < CHECK_ALL_THROTTLE_MS) {
      statusActionNote.textContent = COPY.status.checkAllThrottled;
      return;
    }
    lastCheckAllAt = now;
    checkAllButton.disabled = true;
    checkAllButton.textContent = COPY.status.checkAllRunning;
    statusActionNote.textContent = '';
    void (async () => {
      try {
        await Promise.all([
          hydrateHubStatusRows(storedHubSignature()),
          hydrateLocalStatusRows(),
        ]);
      } finally {
        if (!disposed) {
          checkAllButton.disabled = false;
          checkAllButton.textContent = COPY.status.checkAll;
        }
      }
    })();
  });

  copyReportButton.addEventListener('click', () => {
    statusModel.generatedAt = Date.now();
    statusModel.hubBaseUrl = normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl);
    statusModel.readiness = buildReadiness();
    const report = buildStatusReport(statusModel);
    void navigator.clipboard
      ?.writeText(report)
      .then(() => {
        statusActionNote.textContent = COPY.status.copyReportDone;
      })
      .catch(() => {
        statusActionNote.textContent = COPY.status.copyReportFailed;
      });
    if (!navigator.clipboard) {
      statusActionNote.textContent = COPY.status.copyReportFailed;
    }
  });

  refreshStatusView(); // initial paint: the loading line until the first datum

  // ─── AI Models ───────────────────────────────────────────

  const saveToast = document.createElement('div');
  saveToast.className = 'chatgoose-save-toast';
  saveToast.setAttribute('role', 'status');
  saveToast.setAttribute('aria-live', 'polite');
  saveToast.textContent = 'Saved ✓';
  document.body.append(saveToast);
  let saveToastTimer: number | undefined;
  const showSaveToast = (): void => {
    saveToast.classList.add('chatgoose-save-toast-visible');
    if (saveToastTimer !== undefined) {
      window.clearTimeout(saveToastTimer);
    }
    saveToastTimer = window.setTimeout(() => {
      saveToast.classList.remove('chatgoose-save-toast-visible');
    }, 1600);
  };
  cleanupTasks.push(() => {
    if (saveToastTimer !== undefined) {
      window.clearTimeout(saveToastTimer);
    }
    saveToast.remove();
  });

  let agencyHubApiKeyDirty = false;
  const settingsFormSignature = (): string => JSON.stringify([
    getSelectedTheme(),
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
      uiTheme: getSelectedTheme(),
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
      showSaveToast();

      agencyHubUrlInput.value = mergedSettings.agencyHubBaseUrl;
      if (!agencyHubApiKeyDirty && document.activeElement !== agencyHubKeyInput) {
        agencyHubKeyInput.value = mergedSettings.agencyHubApiKey;
      }

      // Reflect the sanitized/clamped counts back into the fields so an
      // out-of-range or blank entry doesn't keep displaying a value that differs
      // from what was stored. Skip a field the user is still editing.
      const writeCount = (input: HTMLInputElement, value: number): void => {
        if (document.activeElement !== input) {
          const previous = input.value;
          input.value = String(value);
          // The store clamped/normalized what was typed — say so instead of
          // silently rewriting the field.
          if (previous !== '' && previous !== String(value)) {
            flashClampHint(input, value);
          }
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

  quiesceSettingsBeforeSignOut = async (): Promise<void> => {
    // DROP the pending snapshot rather than flushing it: it may carry the very
    // legacy key the sign-out is about to destroy, and writing it seconds before
    // the wipe only widens the resurrection window. Clearing the dirty flags
    // also stops a queued blur from re-scheduling the same snapshot.
    saveSettingsDebounced.cancel();
    settingsDirty = false;
    agencyHubApiKeyDirty = false;
    // An already-running write is past cancellation — join it so the wipe
    // strictly follows it. `settingsSaveChain` never rejects (queueSettingsSave
    // attaches its own catch), so this cannot fail the sign-out.
    await (settingsSaveChain ?? Promise.resolve());
  };

  // Toggle the cost warning the moment the picker changes, ahead of any save,
  // and keep its message tracking the deep-window field as the chatter types.
  coachRecapSelect.addEventListener('change', updateCoachRecapWarning);
  deepInput.addEventListener('input', updateCoachRecapWarning);

  [
    ...themeRadios,
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
    'Model Personalities',
    'Global personalities are managed by Agency Hub admins. This extension only reads the catalog and stores account mappings.',
  );
  const personalitiesList = document.createElement('div');
  personalitiesList.style.display = 'grid';
  personalitiesList.style.gap = '10px';
  let refreshAccountMappingPersonalityOptions: (() => void) | null = null;

  const renderPersonaCatalog = (): void => {
    // A repopulated catalog can flip the «персона назначена» step: a mapping
    // migrateState hid may now resolve to an active persona.
    refreshStatusView();
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
  // One section per pane — the rail carries the reading order now (setup
  // order: the hub everything depends on, then the personas it serves, then
  // the accounts they map to, then the local-only settings).
  shell.panes.hub.append(agencyHubSection);
  shell.panes.personas.append(personalitiesSection);
  shell.panes.accounts.append(mappingsSection);
  shell.panes.generation.append(apiSection);
  shell.panes.appearance.append(appearanceSection);


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
  // The mapped persona's name already lives in the select — the info cell
  // carries only what the select can't: connection state and a dead mapping.
  const renderMappingInfo = (
    info: HTMLElement,
    view: { label: string; usable: boolean } | null,
    connected: boolean,
  ): void => {
    info.replaceChildren(
      createStatusPill(
        connected ? 'ok' : 'neutral',
        connected ? 'Connected' : 'Disconnected',
      ),
    );
    if (view && !view.usable) {
      info.append(createStatusPill('warn', 'Persona unavailable'));
    }
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
        renderMappingInfo(info, selectedView, select.dataset.connected === 'true');
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
      // The barrier freezes editors, not navigation: the read-only emergency
      // mode must keep every pane reachable through the rail.
      for (const control of root.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement
      >('input, select, textarea, button:not(.chatgoose-cabinet-item)')) {
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

      const headingText = formatAccountHeading(accountId, session);
      const labelTitle = document.createElement('div');
      labelTitle.textContent = headingText;
      labelTitle.style.fontWeight = '600';
      if (headingText === shortenAccountId(session?.resolvedAccountId ?? accountId)) {
        // No resolved name yet — the heading IS the id, so render it as data.
        labelTitle.classList.add('chatgoose-mono');
        labelTitle.style.fontWeight = '500';
      }

      label.append(
        labelTitle,
        createCopyableId(session?.resolvedAccountId ?? accountId),
      );

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
            // A fresh mapping can flip the «персона назначена» step.
            refreshStatusView();
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
      info.style.display = 'flex';
      info.style.flexDirection = 'column';
      info.style.alignItems = 'flex-end';
      info.style.gap = '4px';
      renderMappingInfo(info, mappedView, Boolean(session?.connected));

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

  // True while the chatter is inside the mappings table — a persona <select> has
  // focus (possibly with its dropdown open). `replaceChildren` there destroys
  // the focused element, closing the popup and dropping the keyboard position.
  const mappingsTableHasFocus = (): boolean => {
    const active = document.activeElement;
    return active instanceof Node &&
      active !== document.body &&
      mappingsTable.contains(active);
  };

  // Paint the account section + the Fansly status row from ONE sessions result.
  // Shared by the mount hydration and the focus/visibility re-poll so the
  // identity-rekey read path (loadStorageState after the snapshot resolves) is
  // never duplicated: the snapshot request owns rekey background-side, and this
  // reads the reconciled state exactly once afterward.
  //
  // `repoll` marks the background refresh (focus/visibility), which the chatter
  // did not ask for and must not feel: it never rebuilds a table the chatter is
  // working inside, and a transient failure leaves the healthy table standing
  // instead of painting «refresh failed» over live data.
  const applySessionsResult = async (
    result: SessionsResult,
    options: { repoll?: boolean } = {},
  ): Promise<void> => {
    if (disposed) {
      return;
    }
    const repoll = options.repoll === true;
    if (!result.ok) {
      console.error('Failed to load Fansly sessions for Settings', result.error);
      // On the mount path the failure state IS the honest first paint. On a
      // re-poll the table already shows a successfully loaded snapshot, and a
      // transient snapshot failure is no reason to replace it with a warning.
      if (!repoll) {
        renderAccountMappings([], true);
      }
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
      // A background re-poll must never yank the control under the chatter's
      // hands: `renderAccountMappings` calls `replaceChildren`, which would
      // destroy a focused persona <select> (and its open dropdown) mid-choice.
      // The status row still repaints — it holds no focusable state — and the
      // next re-poll (or any explicit action) rebuilds the table once focus
      // has left it.
      if (!repoll || !mappingsTableHasFocus()) {
        renderAccountMappings(result.sessions, false);
      }
      paintFanslyStatusRow(result.sessions, false);
    } catch (error) {
      console.error('Failed to refresh account state for Settings', error);
      if (!disposed) {
        if (!repoll) {
          renderAccountMappings([], true);
        }
        paintFanslyStatusRow([], true);
      }
    }
  };

  const hydrateAccountSections = async (): Promise<void> => {
    await applySessionsResult(await sessionsResultPromise);
  };

  // Re-poll sessions when the tab regains focus/visibility, throttled so it only
  // fires once per window. A chatter who connects a model in another tab and
  // returns here should see the Fansly row close without a reload — but the
  // re-poll rides the SAME snapshot+paint flow above (rekey stays
  // background-side), so no live-read logic is duplicated. The in-flight guard
  // collapses a paired focus + visibilitychange into a single poll.
  let sessionsRepollInFlight = false;
  const repollSessions = async (): Promise<void> => {
    if (disposed || sessionsRepollInFlight) {
      return;
    }
    if (Date.now() - lastSessionsPollAt < SESSIONS_REPOLL_MIN_INTERVAL_MS) {
      return;
    }
    sessionsRepollInFlight = true;
    try {
      await applySessionsResult(await loadSessionsResult(), { repoll: true });
    } finally {
      sessionsRepollInFlight = false;
    }
  };
  const handleVisibilityRepoll = (): void => {
    if (document.visibilityState === 'visible') {
      void repollSessions();
    }
  };
  const handleFocusRepoll = (): void => {
    void repollSessions();
  };
  document.addEventListener('visibilitychange', handleVisibilityRepoll);
  window.addEventListener('focus', handleFocusRepoll);
  cleanupTasks.push(() => {
    document.removeEventListener('visibilitychange', handleVisibilityRepoll);
    window.removeEventListener('focus', handleFocusRepoll);
  });

  void hydrateAccountSections();
  // The stored-snapshot signature is what mount fires against: the form fields
  // were initialized from `state.settings`, so live == stored right now.
  void hydrateHubStatusRows(storedHubSignature());
  // Local reads — no hub round-trip, no signature guard.
  void hydrateLocalStatusRows();
  // Which device token is stored here. Absent for tokens issued before this
  // version — the pane says so instead of guessing a date.
  void sendRuntimeRequest('getAgencyHubDeviceTokenMeta')
    .then((meta) => {
      if (disposed) return;
      deviceTokenMeta = asDeviceTokenMeta(meta);
      renderHubSignInState();
    })
    .catch(() => undefined);

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
