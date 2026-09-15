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
  createPaneHead,
  createSection,
  createStatusPill,
  createStatusRow,
  createVersionTag,
  debounce,
  factRow,
  labeledField,
  setStatusPill,
  type BadgeTone,
  type StatusPillKind,
} from './dom.js';
import { COPY } from './copy.js';
import { renderHotkeysPane } from './hotkeys-pane.js';
import { detectLabelPlatform } from '../shared/hotkeys.js';
import {
  buildPersonaRowViews,
  classifyPersonaEmptyState,
  formatCatalogChangedDate,
  type PersonaEmptyState,
} from './personas.js';
import {
  buildSessionLookup,
  formatAccountHeading,
  formatCaptureStatus,
  shortenAccountId,
} from './sessions.js';
import {
  OPTIONS_PANES,
  parseOptionsHash,
  type PaneKey,
} from '../shared/options-routes.js';
import { createShell, navigateTo, renderRailFoot } from './shell.js';
import {
  buildAgencyHubOriginPattern,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import { personaCatalogSource } from '../shared/persona-catalog.js';
import {
  createUserError,
  findErrorKeyByCode,
  formatUserErrorTechnicalDetail,
  getErrorMessage,
  getUserErrorDescription,
} from '../shared/errors.js';
import {
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  CHANGELOG_URL,
  DEFAULT_AGENCY_HUB_BASE_URL,
  START_PAGE_URL,
  WHATS_NEW_2_URL,
  COACH_HISTORY_LIMIT_MAX,
  COACH_HISTORY_LIMIT_MIN,
  IMPROVE_MAX_MESSAGE_COUNT,
  IMPROVE_MIN_MESSAGE_COUNT,
  PING_MAX_MESSAGE_COUNT,
  PING_MIN_MESSAGE_COUNT,
  QUICK_MAX_MESSAGE_COUNT,
  QUICK_MIN_MESSAGE_COUNT,
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
import { sendRuntimeRequest } from '../shared/runtime-request.js';
import {
  loadStorageState,
  readStorageState,
  saveAccountMapping,
  saveSettings,
} from '../shared/storage.js';
import { installUiTheme, resolveUiTheme, systemPrefersDark } from '../shared/theme.js';
import type {
  AccountsView,
  AccountsViewEntry,
  AgencyHubDeviceTokenMeta,
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AgencyHubSignOutResponse,
  AiQuotaStatus,
  OnboardingSnapshot,
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
/** How long a deep link's row stays highlighted. Long enough to find with the
 * eye, short enough that it never reads as a permanent state. */
const DEEP_LINK_FLASH_MS = 2_000;

type SessionsResult =
  | { ok: true; sessions: SessionSnapshotEntry[] }
  | { ok: false; error: unknown };

/** A runtime reply is only as trustworthy as its shape. A stale background, a
 * truncated frame or a harness with no handler resolves to something that is
 * NOT the declared type; painting it would fabricate a verdict, so every
 * optional read passes through a guard and falls back to honest-unknown. */

/**
 * …and for the «Статус» local reads that verdict has to travel in the RESULT,
 * not in the value: `[]` and `null` are exactly what those sources look like on a
 * quiet install, so a parser that collapsed a malformed reply into one of them
 * would make the pane AND the copied report claim «сегодня генераций не было» /
 * «доска ещё не открывалась» about state nobody could read. `{ok: false}` is the
 * discriminator between «parsed, and it is genuinely empty» and «this reply
 * cannot be used» — the latter paints the same «недоступно» a rejected read does.
 */
type ParsedReply<T> = { ok: true; value: T } | { ok: false };
const UNUSABLE_REPLY: { ok: false } = { ok: false };

function parseOpsDailySnapshot(value: unknown): ParsedReply<OpsDailySnapshot> {
  if (typeof value !== 'object' || value === null) return UNUSABLE_REPLY;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    Array.isArray(record.hubErrors) &&
    typeof record.hubErrorsTotal === 'number'
    ? { ok: true, value: value as OpsDailySnapshot }
    : UNUSABLE_REPLY;
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

/** An unreadable reply is NOT «never onboarded»: an older background (or a
 * dropped frame) must never resurrect the first-run checklist over a working
 * install, so only a well-formed v1 record can make the page consider it. */
function asOnboardingSnapshot(value: unknown): OnboardingSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const dismissedAt = record.dismissedAt;
  if (dismissedAt !== null && typeof dismissedAt !== 'number') return null;
  return { version: 1, dismissedAt: typeof dismissedAt === 'number' ? dismissedAt : null };
}

/** The quota reply is a MAP keyed by page label; the EMPTY map is valid («no
 * observation today»). A fulfilled `undefined`, an array or a scalar is not. */
function parseQuotaEntries(value: unknown): ParsedReply<AiQuotaStatus[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return UNUSABLE_REPLY;
  }
  return {
    ok: true,
    value: Object.values(value as Record<string, unknown>).filter(
      (entry): entry is AiQuotaStatus =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AiQuotaStatus).pageLabel === 'string',
    ),
  };
}

/** `null` is the DECLARED honest answer here — «the board was never observed» —
 * so it parses successfully; only a non-null reply that is not an observation
 * (undefined, a scalar, an object with no outcome) is unusable. */
function parseSpendersObservation(value: unknown): ParsedReply<SpendersObservation | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'object') return UNUSABLE_REPLY;
  const record = value as Record<string, unknown>;
  return record.outcome === 'ok' || record.outcome === 'fail'
    ? { ok: true, value: value as SpendersObservation }
    : UNUSABLE_REPLY;
}

/**
 * One account row as the PANE knows it. The background's contract has three
 * states; the pane adds a fourth for its degraded path (see
 * `buildAccountRowViews`) — «this browser has no observation either way», which
 * is not the same claim as «сессий не было». It never travels: nothing sends an
 * `AccountRowView` back to the background, and `asAccountsView` still admits
 * only the three contract states from it.
 */
type AccountRowView = Omit<AccountsViewEntry, 'state'> & {
  state: AccountsViewEntry['state'] | 'unknown';
};

function asAccountsView(value: unknown): AccountsView | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.accounts) || typeof record.unattributedFanslyTabs !== 'number') {
    return null;
  }
  const accounts = record.accounts.filter((entry): entry is AccountsViewEntry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.accountId === 'string' &&
      Boolean(candidate.accountId) &&
      typeof candidate.label === 'string' &&
      (candidate.state === 'live' || candidate.state === 'seen' || candidate.state === 'never');
  });
  return { accounts, unattributedFanslyTabs: record.unattributedFanslyTabs };
}

function formatClockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Coarse age for the Spenders row. Deliberately three buckets: the row
 * answers «is this data current», not «exactly when». Null when the age cannot
 * be computed — `typeof x === 'number'` still admits NaN from a corrupt
 * session-storage record, and «данные свежие» is the one answer such a record
 * must never produce: a false claim of freshness over a stalled feed is worse
 * than visible garbage, because nobody looks at it twice. */
function formatSpendersDataAge(builtAt: number): string | null {
  const ageMs = Date.now() - builtAt;
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < 60 * 60 * 1000) return COPY.status.spendersDataFresh;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 24) return COPY.status.spendersDataHours.replace('{n}', String(hours));
  return COPY.status.spendersDataDays.replace('{n}', String(Math.floor(hours / 24)));
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}

/** «была {when}» for an account this browser is not currently holding a session
 * for. A bare «21:40» three days later would read as today, so anything older
 * than yesterday carries its date. */
function formatSeenWhen(at: number): string {
  const seenAt = new Date(at);
  const now = new Date();
  const time = formatClockTime(at);
  if (isSameLocalDay(seenAt, now)) {
    return COPY.accounts.whenToday.replace('{time}', time);
  }
  if (isSameLocalDay(seenAt, new Date(now.getTime() - 24 * 60 * 60 * 1000))) {
    return COPY.accounts.whenYesterday.replace('{time}', time);
  }
  const date = `${String(seenAt.getDate()).padStart(2, '0')}.${String(seenAt.getMonth() + 1).padStart(2, '0')}`;
  return COPY.accounts.whenDate.replace('{date}', date).replace('{time}', time);
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
  /** Which reads could NOT be used — rejected, or fulfilled with a reply whose
   * shape the parser refused. An empty `quotaByPage`, a null `spenders` and a
   * zero-account `fansly` are ambiguous on their own — they are equally the
   * honest-empty state and the failed-read state — so the failure is carried
   * explicitly. Without it both the rows and the report would print «сегодня
   * генераций не было» / «аккаунты не обнаружены» about a source nobody managed
   * to read. */
  unavailable: {
    quota: boolean;
    opsDaily: boolean;
    spenders: boolean;
    /** The sessions snapshot the Fansly row is painted from. Its failure used to
     * stop at the row: the report still printed the zero-account claim. */
    fansly: boolean;
  };
  readiness: ReadinessStep[];
}

/**
 * A readiness prerequisite has THREE answers, not two. `open` means «this is
 * really missing and here is the button»; `done` means «checked and satisfied».
 * `indeterminate` is the third: the datum that would settle the step could not
 * be read at all. A two-state model has to fold it into one of the lies — either
 * «подключить Agency Hub» about credentials that are already stored, or (worse,
 * if the step is simply dropped) «Готово к смене · Hub на связи» about a Hub
 * that never answered.
 */
type ReadinessStepState = 'done' | 'open' | 'indeterminate';

interface ReadinessStep {
  key: string;
  label: string;
  state: ReadinessStepState;
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
    model.unavailable.fansly
      // «аккаунты не обнаружены» is a claim about a snapshot that was READ. After
      // a failed read the support snapshot must say so, not report zero accounts.
      ? COPY.status.fanslyUnavailable
      : model.fansly.accounts === 0
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
        // The page and the projection age, in the same technical register the
        // «Активность» line above uses. Support receives this artefact instead
        // of the screen, so an anonymous «ok · not_allowlisted» is worst here.
        : `${model.spenders.outcome} · ${model.spenders.streamState ?? unknown} · ${
            model.spenders.pageLabel ?? unknown
          } · ${
            typeof model.spenders.builtAt === 'number' &&
            Number.isFinite(model.spenders.builtAt)
              ? new Date(model.spenders.builtAt).toISOString()
              : unknown
          }`
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
    // Three marks for three states. An unverifiable step used to print as `[ ]`
    // — indistinguishable from a genuinely open one — which sent support after
    // a credential nobody had reason to doubt. `[?]` + «неизвестно» keeps the
    // pane's promise inside the snapshot too.
    if (step.state === 'indeterminate') {
      lines.push(`[?] ${step.label} (${unknown})`);
      continue;
    }
    lines.push(`[${step.state === 'done' ? 'x' : ' '}] ${step.label}`);
  }

  return lines.join('\n');
}

/** The account-id meta line doubles as a copy button (popup discipline). */
/** Why the persona section is empty, said honestly. «Каталог пуст» is a claim
 * about the SERVER's answer and may only be made when the server actually
 * answered for these credentials. */
const PERSONA_EMPTY_COPY: Record<PersonaEmptyState, string> = {
  'no-credentials': COPY.personas.emptyFresh,
  'awaiting-refresh': COPY.personas.emptyUnknown,
  'empty-catalog': COPY.personas.emptyConfirmed,
};

function createCopyableId(fullId: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chatgoose-copy-id';
  button.title = COPY.accounts.idCopyTitle.replace('{id}', fullId);
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-live', 'polite');
  // The bare id, no «ID аккаунта:» prefix — the meta line it lives in is the
  // ONE place the full id appears (the heading carries the name or short id).
  const idText = fullId;
  button.textContent = idText;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  const showCopyResult = (copied: boolean): void => {
    button.classList.toggle('chatgoose-copy-id-done', copied);
    button.textContent = copied ? COPY.accounts.idCopied : COPY.accounts.idCopyFailed;
    if (restoreTimer !== undefined) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      button.classList.remove('chatgoose-copy-id-done');
      button.textContent = idText;
    }, COPY_FEEDBACK_MS);
  };
  button.addEventListener('click', () => {
    if (!navigator.clipboard) {
      showCopyResult(false);
      return;
    }
    void navigator.clipboard.writeText(fullId)
      .then(() => showCopyResult(true))
      .catch(() => showCopyResult(false));
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
  const downloadExport = createButton(COPY.personas.legacyDownload, true);
  downloadExport.addEventListener('click', () => {
    downloadExport.disabled = true;
    void exportJson().then((json) => {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `chatgoose-legacy-personas-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      exportStatus.textContent = COPY.personas.legacyDownloaded;
    }).catch((error: unknown) => {
      console.error('Failed to export legacy persona data', error);
      exportStatus.textContent = COPY.personas.legacyDownloadFailed;
    }).finally(() => {
      downloadExport.disabled = false;
    });
  });
  const copyExport = createButton(COPY.personas.legacyCopy, true);
  copyExport.addEventListener('click', () => {
    copyExport.disabled = true;
    void exportJson().then(async (json) => {
      await navigator.clipboard.writeText(json);
      exportStatus.textContent = COPY.personas.legacyCopied;
    }).catch((error: unknown) => {
      console.error('Failed to copy legacy persona data', error);
      exportStatus.textContent = COPY.personas.legacyCopyFailed;
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

  // The cabinet's bottom breathing room belongs to the PANE (styles.css), not
  // to the page root: a root padding on top of the shell's `min-height: 100vh`
  // made every pane — «Вид» with its three cards included — a scrolling page.
  root.replaceChildren();

  // ─── Cabinet frame ─────────────────────────────────────────
  // Panes are built once and shown/hidden; sections below are appended into
  // their pane instead of into the page root. The recovery gates above return
  // before this point — they are deliberately outside the shell.
  // Every pane now has content, so the rail carries the full route list.
  const shell = createShell(root, OPTIONS_PANES);
  cleanupTasks.push(() => shell.dispose());

  /** Assigned by the deep-link block below; every repaint that can produce the
   * highlight's target row calls it through this hook, so nothing depends on
   * declaration order (`renderPersonaCatalog` runs before that block). */
  let flashPendingDeepLink: () => void = () => undefined;

  // ─── Rail footer: version + Changelog ──────────────────────
  // Opening the changelog records THIS version as seen, which is what retires
  // the «нов.» dot. The write is fired first and the tab is opened regardless of
  // how it settles: a failed write leaves the dot on (an unread release note is
  // the safe side), never a link that refuses to open.
  const markVersionSeen = (): void => {
    void sendRuntimeRequest('setLastSeenVersion', { version: extensionVersion })
      .then((reply) => {
        if (!disposed && reply?.ok === true) railFoot.setUnseen(false);
      })
      .catch(() => undefined);
  };
  const railFoot = renderRailFoot(shell.railFootSlot, {
    version: extensionVersion,
    changelogUrl: WHATS_NEW_2_URL,
    onOpenChangelog: () => {
      markVersionSeen();
      void browser.tabs.create({ url: WHATS_NEW_2_URL }).catch((error: unknown) => {
        console.error('Failed to open the changelog', error);
      });
    },
    onOpenChangelogNatively: markVersionSeen,
  });

  const versionHistory = document.createElement('a');
  versionHistory.className = 'chatgoose-cabinet-changelog chatgoose-cabinet-history';
  versionHistory.dataset.role = 'rail-version-history';
  versionHistory.href = CHANGELOG_URL;
  versionHistory.target = '_blank';
  versionHistory.rel = 'noopener noreferrer';
  versionHistory.textContent = COPY.rail.versionHistory;
  shell.railFootSlot.append(versionHistory);

  // ─── Первый запуск: чеклист ────────────────────────────────
  // Shown only on a genuinely untouched install, and it stays until every step
  // is really done. The «fresh» half of the predicate is captured HERE, from the
  // mount snapshot, before any hydration can mutate it — and the durable half
  // (`chatgoose:onboarding`) arrives from the background below. Deliberately not
  // derived from live form state: in v1 typing the hub URL dismissed the
  // checklist that was still explaining the next two steps.
  const freshAtMount =
    !state.settings.agencyHubDeviceToken.trim() &&
    state.knownAccounts.length === 0;

  const onboardingSection = document.createElement('section');
  onboardingSection.className = 'chatgoose-onboarding';
  onboardingSection.dataset.onboarding = 'true';
  // Hidden until the durable flag has been read: a checklist that flashes over a
  // configured install is worse than one that appears a tick late.
  onboardingSection.hidden = true;
  const onboardingHeading = document.createElement('h1');
  onboardingHeading.className = 'chatgoose-onboarding-heading';
  onboardingHeading.textContent = COPY.onboarding.greeting;
  const onboardingSub = document.createElement('div');
  onboardingSub.className = 'chatgoose-onboarding-sub';
  onboardingSub.textContent = COPY.onboarding.greetingSubtitle;
  const onboardingList = document.createElement('ol');
  onboardingList.className = 'chatgoose-onboarding-steps';

  type OnboardingStepKey = 'invite' | 'signIn' | 'fansly';
  const buildOnboardingStep = (
    key: OnboardingStepKey,
    ordinal: number,
    title: string,
    hint: string,
    actionLabel: string,
    onAction: () => void,
  ): {
    root: HTMLElement;
    action: HTMLButtonElement;
    done: HTMLElement;
    unknown: HTMLElement;
  } => {
    const item = document.createElement('li');
    item.className = 'chatgoose-onboarding-step';
    item.dataset.onboardingStep = key;
    item.dataset.done = 'false';
    const number = document.createElement('span');
    number.className = 'chatgoose-onboarding-step-num';
    number.textContent = String(ordinal);
    const body = document.createElement('div');
    body.className = 'chatgoose-onboarding-step-body';
    const titleNode = document.createElement('div');
    titleNode.className = 'chatgoose-onboarding-step-title';
    titleNode.textContent = title;
    const hintNode = document.createElement('div');
    hintNode.className = 'chatgoose-onboarding-step-hint';
    hintNode.textContent = hint;
    body.append(titleNode, hintNode);
    const action = createButton(actionLabel, true);
    action.dataset.onboardingAction = key;
    action.addEventListener('click', onAction);
    // The green «готово» that replaces the CTA once the step is truly satisfied.
    const done = createBadge(COPY.onboarding.stepDone, 'green');
    done.dataset.onboardingDone = key;
    done.hidden = true;
    // …and its NEUTRAL sibling for the third answer: the step could not be
    // checked at all. Deliberately not green — an unread check is not a pass.
    const unknown = createBadge(COPY.onboarding.stepUnknown, 'neutral');
    unknown.dataset.onboardingUnknown = key;
    unknown.hidden = true;
    item.append(number, body, action, done, unknown);
    onboardingList.append(item);
    return { root: item, action, done, unknown };
  };

  // Step order is the chatter's own (E123): the invite link sets the password,
  // the password signs this device in, Fansly comes last. The host permission
  // is no longer a step of its own — «Войти» asks for it on the same click.
  const onboardingSteps: Record<
    OnboardingStepKey,
    { root: HTMLElement; action: HTMLButtonElement; done: HTMLElement; unknown: HTMLElement }
  > = {
    invite: buildOnboardingStep(
      'invite',
      1,
      COPY.onboarding.step1Title,
      COPY.onboarding.step1Hint,
      COPY.onboarding.step1Action,
      () => {
        void browser.tabs.create({ url: START_PAGE_URL }).catch((error: unknown) => {
          console.error('Failed to open the start page', error);
        });
      },
    ),
    signIn: buildOnboardingStep(
      'signIn',
      2,
      COPY.onboarding.step2Title,
      COPY.onboarding.step2Hint,
      COPY.onboarding.step2Action,
      () => navigateTo('hub'),
    ),
    fansly: buildOnboardingStep(
      'fansly',
      3,
      COPY.onboarding.step3Title,
      COPY.onboarding.step3Hint,
      COPY.onboarding.step3Action,
      () => navigateTo('accounts'),
    ),
  };

  const onboardingHint = document.createElement('div');
  onboardingHint.className = 'chatgoose-status-hint';
  onboardingHint.textContent = COPY.onboarding.hint;
  onboardingSection.append(
    onboardingHeading,
    onboardingSub,
    onboardingList,
    onboardingHint,
  );
  shell.panes.status.append(onboardingSection);

  // ─── Readiness headline ────────────────────────────────────
  // The install's verdict in one line. It derives entirely from the SAME
  // `statusModel` the Статус rows paint from — zero extra requests — and counts
  // ONLY the actionable prerequisites (E41): an unknown quota or an unopened
  // Spenders board is an observation, not a broken install.
  // It is the first block INSIDE the rows card (E61), not a plate of its own —
  // the two stacked cards said one thing twice — and it no longer carries the
  // version pill: that pill was positioned for a 28px-padded card it no longer
  // lived in, and the same version already renders in the rail footer. The
  // support card below states it once, in one format.
  const readinessHero = document.createElement('section');
  readinessHero.className = 'chatgoose-readiness chatgoose-readiness-inline';
  readinessHero.dataset.readinessHero = 'true';
  const readinessHeading = document.createElement('h1');
  readinessHeading.className = 'chatgoose-readiness-heading';
  readinessHeading.textContent = COPY.status.checkingTitle;
  const readinessSub = document.createElement('div');
  readinessSub.className = 'chatgoose-readiness-sub';
  readinessSub.textContent = COPY.status.checkingSubtitle;
  readinessHero.append(readinessHeading, readinessSub);
  // The open-steps list is the body of the «Что мешает» card in the pane's right
  // column; it stays THIS element so the headline renderer keeps one writer.
  const readinessOpen = document.createElement('ul');
  readinessOpen.className = 'chatgoose-readiness-open';
  readinessOpen.hidden = true;

  // ─── «Вид» ──────────────────────────────────────────────────
  // Three clickable preview cards. Each one still wraps the SAME radio the
  // settings writer already reads, so picking a theme rides the existing
  // debounced save path — no second writer, no new storage field.
  const appearanceSection = document.createElement('section');
  appearanceSection.className = 'chatgoose-pane-plain';
  const appearanceHead = createPaneHead(COPY.appearance.title, COPY.appearance.subtitle);
  const themeChoices: Array<{ value: UiThemeSetting; title: string; hint: string }> = [
    { value: 'system', title: COPY.appearance.systemTitle, hint: COPY.appearance.systemHint },
    { value: 'light', title: COPY.appearance.lightTitle, hint: COPY.appearance.lightHint },
    { value: 'dark', title: COPY.appearance.darkTitle, hint: COPY.appearance.darkHint },
  ];
  const themeCards = document.createElement('div');
  themeCards.className = 'chatgoose-theme-cards';
  const themeRadios: HTMLInputElement[] = [];
  for (const choice of themeChoices) {
    const card = document.createElement('label');
    card.className = 'chatgoose-theme-card';
    card.dataset.themeCard = choice.value;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'chatgoose-ui-theme';
    radio.value = choice.value;
    radio.checked = state.settings.uiTheme === choice.value;
    // Visually hidden, NOT display:none — the radio must keep its place in the
    // tab order and in the group's arrow-key navigation.
    radio.className = 'chatgoose-theme-radio';
    // A miniature of the cabinet in that theme: a rail and two content bars.
    // Pure CSS with FIXED colours (never the theme variables) — a preview of the
    // light theme has to look light while the page itself is dark.
    const preview = document.createElement('span');
    preview.className = `chatgoose-theme-preview chatgoose-theme-preview-${choice.value}`;
    preview.setAttribute('aria-hidden', 'true');
    const previewRail = document.createElement('span');
    previewRail.className = 'chatgoose-theme-preview-rail';
    const previewBody = document.createElement('span');
    previewBody.className = 'chatgoose-theme-preview-body';
    const previewBar = document.createElement('span');
    previewBar.className = 'chatgoose-theme-preview-bar';
    const previewBarShort = document.createElement('span');
    previewBarShort.className = 'chatgoose-theme-preview-bar chatgoose-theme-preview-bar-short';
    const previewButton = document.createElement('span');
    previewButton.className = 'chatgoose-theme-preview-btn';
    previewBody.append(previewBar, previewBarShort, previewButton);
    preview.append(previewRail, previewBody);
    if (choice.value === 'system') {
      // A complete dark miniature clipped to the right half (see styles.css):
      // background, rail and bars all flip on ONE vertical line.
      const darkHalf = document.createElement('span');
      darkHalf.className = 'chatgoose-theme-preview-sysdark';
      const darkRail = document.createElement('span');
      darkRail.className = 'chatgoose-theme-preview-rail';
      const darkBody = document.createElement('span');
      darkBody.className = 'chatgoose-theme-preview-body';
      const darkBar = document.createElement('span');
      darkBar.className = 'chatgoose-theme-preview-bar';
      const darkBarShort = document.createElement('span');
      darkBarShort.className = 'chatgoose-theme-preview-bar chatgoose-theme-preview-bar-short';
      const darkButton = document.createElement('span');
      darkButton.className = 'chatgoose-theme-preview-btn';
      darkBody.append(darkBar, darkBarShort, darkButton);
      darkHalf.append(darkRail, darkBody);
      preview.append(darkHalf);
    }
    const title = document.createElement('span');
    title.className = 'chatgoose-theme-title';
    title.textContent = choice.title;
    const hint = document.createElement('span');
    hint.className = 'chatgoose-theme-hint';
    hint.textContent = choice.hint;
    card.append(radio, preview, title, hint);
    themeCards.append(card);
    themeRadios.push(radio);
  }
  const getSelectedTheme = (): UiThemeSetting =>
    (themeRadios.find((radio) => radio.checked)?.value ?? 'system') as UiThemeSetting;

  // The radios are a GROUP; screen readers used to meet three loose radios whose
  // only context was the pane heading (E62).
  themeCards.setAttribute('role', 'radiogroup');
  themeCards.setAttribute('aria-label', COPY.appearance.title);

  /** «Системная» alone is ambiguous — say which half of it the OS is asking for.
   * The note answers about the SYSTEM, never about the live document: read from
   * the resolved theme class it said «сейчас — тёмная» with «Тёмная» explicitly
   * selected, which is true of the page and false of the sentence it was
   * claiming to explain. `resolveUiTheme('system', …)` is that sentence. */
  const renderResolvedTheme = (): void => {
    themeResolvedNote.textContent = resolveUiTheme('system', systemPrefersDark()) === 'dark'
      ? COPY.appearance.resolvedDark
      : COPY.appearance.resolvedLight;
  };

  const appearanceGrid = document.createElement('div');
  appearanceGrid.className = 'chatgoose-panegrid';
  const themeCard = document.createElement('div');
  themeCard.className = 'chatgoose-panecard';
  const themeCardHead = document.createElement('div');
  themeCardHead.className = 'chatgoose-panecard-head';
  const themeCardTitle = document.createElement('span');
  themeCardTitle.className = 'chatgoose-panecard-title';
  themeCardTitle.textContent = COPY.appearance.themeCardTitle;
  // What «Системная» resolves to RIGHT NOW. `resolveUiTheme` existed and this
  // pane never called it.
  const themeResolvedNote = document.createElement('span');
  themeResolvedNote.className = 'chatgoose-panecard-note';
  themeResolvedNote.dataset.role = 'theme-resolved';
  themeCardHead.append(themeCardTitle, themeResolvedNote);
  themeCard.append(themeCardHead, themeCards);

  // The surface the subtitle promises: the panel in the Fansly chat. The old
  // miniature drew the cabinet — the one surface the chatter is already looking
  // at while reading this pane.
  const chatPreviewCard = document.createElement('div');
  chatPreviewCard.className = 'chatgoose-panecard';
  const chatPreviewHead = document.createElement('div');
  chatPreviewHead.className = 'chatgoose-panecard-head';
  const chatPreviewTitle = document.createElement('span');
  chatPreviewTitle.className = 'chatgoose-panecard-title';
  chatPreviewTitle.textContent = COPY.appearance.chatCardTitle;
  chatPreviewHead.append(chatPreviewTitle);
  const chatPreview = document.createElement('div');
  chatPreview.className = 'chatgoose-chat-preview';
  chatPreview.dataset.role = 'chat-preview';
  chatPreview.setAttribute('aria-hidden', 'true');
  const chatPreviewBar = document.createElement('div');
  chatPreviewBar.className = 'chatgoose-chat-preview-bar';
  const chatPreviewName = document.createElement('span');
  chatPreviewName.textContent = COPY.rail.brand;
  const chatPreviewTone = document.createElement('span');
  chatPreviewTone.className = 'chatgoose-chat-preview-tone';
  chatPreviewTone.textContent = COPY.appearance.chatToneChip;
  chatPreviewBar.append(chatPreviewName, chatPreviewTone);
  const chatPreviewBody = document.createElement('div');
  chatPreviewBody.className = 'chatgoose-chat-preview-body';
  for (const width of ['100%', '100%', '62%']) {
    const line = document.createElement('span');
    line.className = 'chatgoose-chat-preview-line';
    line.style.width = width;
    chatPreviewBody.append(line);
  }
  const chatPreviewActions = document.createElement('div');
  chatPreviewActions.className = 'chatgoose-chat-preview-actions';
  const chatPreviewPrimary = document.createElement('span');
  chatPreviewPrimary.className = 'chatgoose-chat-preview-btn';
  const chatPreviewGhost = document.createElement('span');
  chatPreviewGhost.className = 'chatgoose-chat-preview-btn chatgoose-chat-preview-btn-ghost';
  chatPreviewActions.append(chatPreviewPrimary, chatPreviewGhost);
  chatPreviewBody.append(chatPreviewActions);
  chatPreview.append(chatPreviewBar, chatPreviewBody);
  const chatPreviewNote = document.createElement('div');
  chatPreviewNote.className = 'chatgoose-status-hint';
  chatPreviewNote.textContent = COPY.appearance.chatCardNote;

  // The explanatory layer is useful while learning the row, but it must be a
  // preference once the controls are muscle memory. Keep the checkbox itself
  // as the control; the family switch is presentation only.
  const toolbarHintsInput = document.createElement('input');
  toolbarHintsInput.type = 'checkbox';
  toolbarHintsInput.checked = state.settings.showToolbarHints;
  toolbarHintsInput.dataset.role = 'toolbar-hints-toggle';
  const toolbarHintsSwitch = document.createElement('span');
  toolbarHintsSwitch.className = 'chatgoose-switch';
  const toolbarHintsTrack = document.createElement('span');
  toolbarHintsTrack.className = 'chatgoose-switch-track';
  toolbarHintsSwitch.append(toolbarHintsInput, toolbarHintsTrack);
  const toolbarHintsRow = document.createElement('label');
  toolbarHintsRow.className = 'chatgoose-row chatgoose-toolbar-hints-row';
  const toolbarHintsLabels = document.createElement('span');
  toolbarHintsLabels.className = 'chatgoose-row-labels';
  const toolbarHintsTitle = document.createElement('span');
  toolbarHintsTitle.className = 'chatgoose-row-label';
  toolbarHintsTitle.textContent = COPY.appearance.toolbarHintsTitle;
  const toolbarHintsHint = document.createElement('span');
  toolbarHintsHint.className = 'chatgoose-row-sub';
  toolbarHintsHint.textContent = COPY.appearance.toolbarHintsHint;
  toolbarHintsLabels.append(toolbarHintsTitle, toolbarHintsHint);
  toolbarHintsRow.append(toolbarHintsLabels, toolbarHintsSwitch);

  chatPreviewCard.append(
    chatPreviewHead,
    chatPreview,
    chatPreviewNote,
    toolbarHintsRow,
  );

  appearanceGrid.append(themeCard, chatPreviewCard);
  appearanceSection.append(appearanceHead.root, appearanceGrid);
  renderResolvedTheme();
  // The OS scheme is the note's ONLY input, so the OS query is what it listens
  // to. The document class it used to watch is the wrong signal twice over: with
  // an explicit theme picked the class never moves when the OS flips (a stale
  // note), and it moves when the chatter picks a theme (a note about the choice,
  // not about the system).
  const themeSystemQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  if (themeSystemQuery) {
    themeSystemQuery.addEventListener('change', renderResolvedTheme);
    cleanupTasks.push(() => themeSystemQuery.removeEventListener('change', renderResolvedTheme));
  }

  // ─── «Генерация» (Stage 32: keys/models are kernel-side) ────
  const apiSection = document.createElement('section');
  apiSection.className = 'chatgoose-pane-plain';

  // Bounds come from the SAME constants the storage clamp uses — they used to be
  // string literals here, free to drift from the clamp in silence. The step is
  // what makes the −/+ affordance usable: with the browser default of 1 the
  // «Глубокое окно» stepper needed 2900 clicks to cross its range (E62).
  const windowInput = (value: number, min: number, max: number, step: number): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'chatgoose-input chatgoose-input-num';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    return input;
  };

  const quickInput = windowInput(
    state.settings.quickMessageCount,
    QUICK_MIN_MESSAGE_COUNT,
    QUICK_MAX_MESSAGE_COUNT,
    5,
  );
  const pingInput = windowInput(
    state.settings.pingMessageCount,
    PING_MIN_MESSAGE_COUNT,
    PING_MAX_MESSAGE_COUNT,
    5,
  );
  const improveInput = windowInput(
    state.settings.improveMessageCount,
    IMPROVE_MIN_MESSAGE_COUNT,
    IMPROVE_MAX_MESSAGE_COUNT,
    5,
  );
  const deepInput = windowInput(
    state.settings.deepMessageCount,
    DEEP_MIN_MESSAGE_COUNT,
    DEEP_MAX_MESSAGE_COUNT,
    50,
  );

  const coachHistoryInput = document.createElement('input');
  coachHistoryInput.type = 'number';
  coachHistoryInput.className = 'chatgoose-input chatgoose-input-num';
  coachHistoryInput.min = String(COACH_HISTORY_LIMIT_MIN);
  coachHistoryInput.max = String(COACH_HISTORY_LIMIT_MAX);
  // Turn count is an integer — step=1 keeps the browser's number spinner and
  // validity check on whole turns (sanitizeSettings rounds regardless).
  coachHistoryInput.step = '1';
  coachHistoryInput.value = String(state.settings.coachHistoryLimit);

  // The hidden <select> stays the SINGLE value carrier for auto-recap: the
  // debounced save array, the cross-tab merge and the cost-warning listener all
  // speak to it exactly as when it was visible. The segment below is only the
  // visible layer — its buttons write the select and dispatch its change event.
  const coachRecapSelect = document.createElement('select');
  coachRecapSelect.className = 'chatgoose-select';
  coachRecapSelect.hidden = true;
  const coachRecapChoices: Array<{ value: Settings['coachAutoRecap']; label: string }> = [
    { value: 'off', label: COPY.generation.coachRecapOff },
    { value: 'short', label: COPY.generation.coachRecapShort },
    { value: 'full', label: COPY.generation.coachRecapFull },
  ];
  for (const choice of coachRecapChoices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    coachRecapSelect.append(option);
  }
  coachRecapSelect.value = state.settings.coachAutoRecap;

  // Three aria-pressed buttons, not role=radio: radio semantics promise
  // arrow-key movement this group does not implement, while pressed/unpressed
  // buttons in the tab order describe exactly what the control does.
  const coachRecapSegment = document.createElement('span');
  coachRecapSegment.className = 'chatgoose-segment';
  coachRecapSegment.setAttribute('role', 'group');
  coachRecapSegment.setAttribute('aria-label', COPY.generation.coachRecapTitle);
  const coachRecapButtons = coachRecapChoices.map((choice) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-segment-btn';
    button.dataset.recapChoice = choice.value;
    button.textContent = choice.label;
    button.addEventListener('click', () => {
      if (coachRecapSelect.value === choice.value) {
        return;
      }
      coachRecapSelect.value = choice.value;
      coachRecapSelect.dispatchEvent(new Event('change'));
    });
    return button;
  });
  /** Repaint the segment from the select — the one source of truth. */
  const updateCoachRecapSegment = (): void => {
    for (const button of coachRecapButtons) {
      const selected = button.dataset.recapChoice === coachRecapSelect.value;
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.dataset.selected = selected ? 'true' : 'false';
    }
  };
  coachRecapSegment.append(...coachRecapButtons);
  updateCoachRecapSegment();
  const coachRecapControl = document.createElement('span');
  coachRecapControl.className = 'chatgoose-row-control';
  coachRecapControl.append(coachRecapSegment, coachRecapSelect);

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
    coachRecapWarning.textContent = COPY.generation.coachRecapWarning.replace(
      '{n}',
      String(shownDeep),
    );
    coachRecapWarning.hidden = coachRecapSelect.value !== 'full';
  };
  updateCoachRecapWarning();

  // Family switch instead of a bare checkbox: the checkbox stays the control
  // (checked/focus semantics untouched); the track is presentation only.
  const debugInput = document.createElement('input');
  debugInput.type = 'checkbox';
  debugInput.checked = state.settings.debugMode;
  const debugSwitch = document.createElement('span');
  debugSwitch.className = 'chatgoose-switch';
  const debugSwitchTrack = document.createElement('span');
  debugSwitchTrack.className = 'chatgoose-switch-track';
  debugSwitch.append(debugInput, debugSwitchTrack);

  /**
   * One setting per line: a two-line label (what it is, then what it does) with
   * the control on the right. A DIV by default — a <label> would forward a
   * row click to its FIRST labelable descendant, which for a stepper row is
   * the «−» button; only the single-checkbox row keeps the label affordance.
   */
  const settingRow = (
    title: string,
    hint: string,
    control: HTMLElement,
    opts?: { asLabel?: boolean },
  ): HTMLElement => {
    const row = document.createElement(opts?.asLabel ? 'label' : 'div');
    row.className = 'chatgoose-row';
    const labels = document.createElement('span');
    labels.className = 'chatgoose-row-labels';
    const label = document.createElement('span');
    label.className = 'chatgoose-row-label';
    label.textContent = title;
    const sub = document.createElement('span');
    sub.className = 'chatgoose-row-sub';
    sub.textContent = hint;
    labels.append(label, sub);
    row.append(labels, control);
    return row;
  };

  // The cost warning belongs to the recap row: full-width second line inside it.
  const coachRecapRow = settingRow(
    COPY.generation.coachRecapTitle,
    COPY.generation.coachRecapHint,
    coachRecapControl,
  );
  coachRecapRow.style.flexWrap = 'wrap';
  coachRecapRow.append(coachRecapWarning);

  // Count rows carry their allowed range beside the input; the same hint
  // flashes amber when a save clamps an out-of-range entry. The input rides
  // inside a −/+ stepper: big pointer targets instead of the OS spinners; the
  // field itself still takes typing and arrow keys exactly as before.
  /** Per-input clamp chips and their timers (see `flashClampHint`). */
  const clampChips = new Map<HTMLInputElement, HTMLElement>();
  const clampTimers = new Map<HTMLInputElement, number>();

  const numberRow = (
    title: string,
    hintText: string,
    input: HTMLInputElement,
  ): HTMLElement => {
    // The range lives in a FIXED column so every stepper on the pane lines up —
    // «5–200» and «100–3000» used to hug their steppers and start at different
    // x positions (E62). A step other than 1 is stated: it is what the −/+
    // buttons actually do.
    const hint = document.createElement('span');
    hint.className = 'chatgoose-row-hint';
    const range = document.createElement('span');
    range.textContent = `${input.min}–${input.max}`;
    hint.append(range);
    if (input.step && input.step !== '1') {
      const step = document.createElement('span');
      step.className = 'chatgoose-row-hint-step';
      step.textContent = COPY.generation.stepNote.replace('{n}', input.step);
      hint.append(step);
    }
    // Rows are DIVs now (see settingRow) — the field names itself.
    input.setAttribute('aria-label', title);
    const stepButton = (direction: -1 | 1): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatgoose-stepper-btn';
      button.textContent = direction === 1 ? '+' : '−';
      button.setAttribute(
        'aria-label',
        direction === 1 ? COPY.generation.stepUp : COPY.generation.stepDown,
      );
      // Pointer affordance only: keyboard users step the focused field with
      // arrow keys, so the buttons stay out of the tab order.
      button.tabIndex = -1;
      button.addEventListener('click', () => {
        try {
          if (direction === 1) {
            input.stepUp();
          } else {
            input.stepDown();
          }
        } catch {
          // A blank/non-numeric mid-edit value is not steppable — start over
          // from the low bound rather than silently doing nothing.
          input.value = input.min;
        }
        // A stepper click is both an edit and a commit: input schedules the
        // debounced save, change flushes it (the same pair a native spinner
        // interaction produces by blur time).
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
      return button;
    };
    const stepper = document.createElement('span');
    stepper.className = 'chatgoose-stepper';
    stepper.append(stepButton(-1), input, stepButton(1));
    const control = document.createElement('span');
    // The numeric lane is its OWN class — `.chatgoose-row-control` stays the
    // generic inline-flex wrapper the segmented controls wear.
    control.className = 'chatgoose-row-numeric';
    const clampChip = document.createElement('span');
    clampChip.className = 'chatgoose-row-clamped';
    clampChip.dataset.role = 'clamp-note';
    clampChip.hidden = true;
    clampChips.set(input, clampChip);
    control.append(hint, stepper, clampChip);
    // A wheel over a focused number input silently changes the value while
    // the chatter is just scrolling the page — blur keeps the scroll a scroll.
    input.addEventListener('wheel', () => {
      if (document.activeElement === input) {
        input.blur();
      }
    }, { passive: true });
    return settingRow(title, hintText, control);
  };
  /** «сохранено как N» after a clamp. It is a CHIP under the row now (E62): it
   * used to overwrite the range hint for 2.6s — taking the bounds away exactly
   * when the chatter was being told about them — with a colour change as the
   * only signal that the slot had changed meaning. The timer is registered for
   * cleanup, so it can no longer fire into a disposed DOM. */
  const flashClampHint = (input: HTMLInputElement, value: number): void => {
    const chip = clampChips.get(input);
    if (!chip) {
      return;
    }
    chip.textContent = COPY.generation.savedAs.replace('{n}', String(value));
    chip.hidden = false;
    const previous = clampTimers.get(input);
    if (previous !== undefined) {
      window.clearTimeout(previous);
    }
    const timer = window.setTimeout(() => {
      clampTimers.delete(input);
      chip.hidden = true;
    }, 2600);
    clampTimers.set(input, timer);
  };
  cleanupTasks.push(() => {
    for (const timer of clampTimers.values()) {
      window.clearTimeout(timer);
    }
    clampTimers.clear();
  });

  // `settingGroup` (caption over a bare list of rows) became `settingCard`
  // below when «Генерация» split into two columns of cards (E62).

  // Layout (E62): the four context windows on the left, the coach and the
  // service switch on the right. The «Служебное» caption used to float over a
  // single row whose first- AND last-child padding was zeroed — a caption over
  // nothing.
  const generationHead = createPaneHead(COPY.generation.title, COPY.generation.subtitle);
  const generationGrid = document.createElement('div');
  generationGrid.className = 'chatgoose-panegrid chatgoose-panegrid-even';
  const generationLeft = document.createElement('div');
  generationLeft.className = 'chatgoose-panecol';
  const generationRight = document.createElement('div');
  generationRight.className = 'chatgoose-panecol';

  const settingCard = (caption: string, rows: HTMLElement[], quiet = false): HTMLElement => {
    const card = document.createElement('div');
    card.className = quiet
      ? 'chatgoose-panecard chatgoose-panecard-quiet'
      : 'chatgoose-panecard';
    card.dataset.settingGroup = caption;
    const head = document.createElement('div');
    head.className = 'chatgoose-panecard-head';
    const title = document.createElement('span');
    title.className = 'chatgoose-panecard-title';
    title.textContent = caption;
    head.append(title);
    const list = document.createElement('div');
    list.className = 'chatgoose-rows';
    list.append(...rows);
    card.append(head, list);
    return card;
  };

  generationLeft.append(
    settingCard(COPY.generation.groupWindows, [
      numberRow(COPY.generation.quickTitle, COPY.generation.quickHint, quickInput),
      numberRow(COPY.generation.pingTitle, COPY.generation.pingHint, pingInput),
      numberRow(COPY.generation.improveTitle, COPY.generation.improveHint, improveInput),
      numberRow(COPY.generation.deepTitle, COPY.generation.deepHint, deepInput),
    ]),
  );
  generationRight.append(
    settingCard(COPY.generation.groupCoach, [
      numberRow(
        COPY.generation.coachHistoryTitle,
        COPY.generation.coachHistoryHint,
        coachHistoryInput,
      ),
      coachRecapRow,
    ]),
    settingCard(
      COPY.generation.groupService,
      [
        settingRow(COPY.generation.debugTitle, COPY.generation.debugHint, debugSwitch, {
          asLabel: true,
        }),
      ],
      true,
    ),
  );
  generationGrid.append(generationLeft, generationRight);
  apiSection.append(generationHead.root, generationGrid);

  // ─── «Хоткеи» (read-only reference) ─────────────────────────
  // Derived from the live binding table, so the pane cannot drift from what the
  // keymap dispatches. The platform is detected at render time: the same install
  // shows ⌘⇧ on macOS and Alt+Shift elsewhere.
  const hotkeysSection = document.createElement('section');
  hotkeysSection.className = 'chatgoose-pane-plain';
  const hotkeysPlatform = detectLabelPlatform();
  const hotkeysHead = createPaneHead(COPY.hotkeys.title, COPY.hotkeys.subtitle);
  // Which modifier THIS computer uses. The platform was already detected for the
  // key labels; the page never said it, so a chatter comparing with a colleague's
  // screenshot had no explanation for the difference (E62).
  const hotkeysPlatformTag = document.createElement('span');
  hotkeysPlatformTag.className = 'chatgoose-panehead-stamp';
  hotkeysPlatformTag.dataset.role = 'hotkeys-platform';
  hotkeysPlatformTag.textContent = hotkeysPlatform === 'mac'
    ? COPY.hotkeys.platformMac
    : COPY.hotkeys.platformOther;
  hotkeysHead.side.append(hotkeysPlatformTag);
  const hotkeysCard = document.createElement('div');
  hotkeysCard.className = 'chatgoose-panecard';
  const hotkeysHint = document.createElement('div');
  hotkeysHint.className = 'chatgoose-status-hint';
  hotkeysHint.textContent = COPY.hotkeys.hint;
  hotkeysCard.append(renderHotkeysPane(document, hotkeysPlatform), hotkeysHint);
  const hotkeysBody = document.createElement('div');
  hotkeysBody.className = 'chatgoose-panegrid-single';
  hotkeysBody.append(hotkeysCard);
  hotkeysSection.append(hotkeysHead.root, hotkeysBody);

  // ─── Agency Hub ───────────────────────────────────────────
  // A plain container, not a card: the pane's title lives in its head and the
  // four zones are cards of their own inside the grid below (E61).
  const agencyHubSection = document.createElement('section');
  agencyHubSection.className = 'chatgoose-pane-plain';
  const agencyHubUrlInput = document.createElement('input');
  agencyHubUrlInput.type = 'url';
  agencyHubUrlInput.className = 'chatgoose-input';
  agencyHubUrlInput.placeholder = COPY.hub.baseUrlPlaceholder;
  agencyHubUrlInput.value = state.settings.agencyHubBaseUrl;

  // «Доступ к хосту» / «Связь» — the two status rows of the Подключение zone:
  // label · pill · mono meta at the right edge. The pill element keeps the old
  // variable names — every state renderer below writes through them.
  const hubStatusRow = (
    label: string,
  ): { root: HTMLElement; pill: HTMLElement; mono: HTMLElement } => {
    const root = document.createElement('div');
    root.className = 'chatgoose-hub-srow';
    const labelNode = document.createElement('span');
    labelNode.className = 'chatgoose-hub-srow-label';
    labelNode.textContent = label;
    const pill = document.createElement('span');
    const mono = document.createElement('span');
    mono.className = 'chatgoose-hub-srow-meta';
    root.append(labelNode, pill, mono);
    return { root, pill, mono };
  };

  const agencyHubPermissionRow = hubStatusRow(COPY.hub.permLabel);
  const agencyHubPermissionStatus = agencyHubPermissionRow.pill;
  const agencyHubPermissionMono = agencyHubPermissionRow.mono;

  const agencyHubPermissionMeta = document.createElement('div');
  agencyHubPermissionMeta.className = 'chatgoose-meta';

  // «Разрешить доступ» rides its OWN row directly under the permission fact
  // rather than the zone's shared action row. E61 promised a CG-HUB-04 deep link
  // would highlight «the row that has «Разрешить доступ» in it»; the anchor sat
  // on the status row while the button lived two siblings away, so the flash
  // framed the diagnosis without the cure. Grouping them is what makes the claim
  // true — and keeps «Проверить связь» the zone's single primary.
  const agencyHubPermissionButton = createButton(COPY.status.grantAccess, true);
  const agencyHubPermissionActions = document.createElement('div');
  agencyHubPermissionActions.className = 'chatgoose-hub-srow-actions';
  agencyHubPermissionActions.append(agencyHubPermissionButton);

  // The block IS the deep-link target: fact, explanation and the control that
  // fixes it. `data-deeplink-ready` starts false — `permissions.contains` has not
  // answered yet, and a flash burned on the placeholder cannot be re-armed.
  const agencyHubHostAccessBlock = document.createElement('div');
  agencyHubHostAccessBlock.className = 'chatgoose-hub-hostaccess';
  agencyHubHostAccessBlock.dataset.hubDetail = 'host-access';
  agencyHubHostAccessBlock.dataset.deeplinkReady = 'false';
  agencyHubHostAccessBlock.append(
    agencyHubPermissionRow.root,
    agencyHubPermissionMeta,
    agencyHubPermissionActions,
  );

  const agencyHubConnectionRow = hubStatusRow(COPY.hub.connLabel);
  // The one place the live check is stated (E67) — named so a test can hold it
  // to that, rather than to «whichever mono line comes first».
  agencyHubConnectionRow.root.dataset.role = 'hub-connection';
  const agencyHubConnectionStatus = agencyHubConnectionRow.pill;
  const agencyHubConnectionMono = agencyHubConnectionRow.mono;

  const agencyHubConnectionMeta = document.createElement('div');
  agencyHubConnectionMeta.className = 'chatgoose-meta';

  // «Проверить связь» is THE action of the zone — the only primary on the pane.
  const agencyHubConnectionButton = createButton(COPY.hub.testConnection);
  const agencyHubActionRow = document.createElement('div');
  agencyHubActionRow.style.display = 'flex';
  agencyHubActionRow.style.gap = '8px';
  agencyHubActionRow.style.flexWrap = 'wrap';
  agencyHubActionRow.append(agencyHubConnectionButton);

  let agencyHubConnectionVersion = 0;
  let lastAgencyHubConnectionSignature: string | null = null;
  /** Assigned by the «Статус» block below; every earlier producer calls it
   * through this hook so nothing depends on declaration order. */
  let renderHubDiagnostics: () => void = () => undefined;
  /** Last live connection test: when, outcome and how long. There is only one
   * credential class since v17, so there is nothing left to disambiguate. */
  let lastConnectionCheck: {
    at: number;
    ok: boolean;
    durationMs: number;
    code?: string;
  } | null = null;
  /** True while THIS page owns a custody write — the sign-in / re-issue RPC or
   * «Выйти» — INCLUDING the permission → connection-test → hydrate chain that
   * path runs afterwards. The background's write reaches this document as a
   * `storage.onChanged` event too, and it can arrive before the RPC resolves: the
   * cross-tab fence must then still APPLY the new custody state (it is real) but
   * must NOT re-run that chain, or every hub check would fire twice. */
  let ownCustodyWriteInFlight = false;

  /** The live check's receipt, in ONE place: when · how long · which credential.
   * Both «Связь» states print it — E67 deleted the «Проверка» diagnostics row
   * that used to say the same three facts a card away. */
  const connectionReceipt = (check: NonNullable<typeof lastConnectionCheck>): string => [
    formatClockTime(check.at),
    COPY.hub.checkDuration.replace('{n}', String(check.durationMs)),
  ].join(' · ');

  const renderAgencyHubConnectionState = (): void => {
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const hasInputs = hasAgencyHubConnectionInputs(
      agencyHubUrlInput.value,
      state.settings.agencyHubDeviceToken,
    );

    agencyHubConnectionButton.disabled =
      agencyHubConnectionFeedback.kind === 'testing' || !hasInputs;

    switch (agencyHubConnectionFeedback.kind) {
      case 'idle':
        setStatusPill(agencyHubConnectionStatus, 'neutral', COPY.hub.connPillIdle);
        agencyHubConnectionMono.textContent = '';
        agencyHubConnectionMeta.textContent = COPY.hub.connIdleMeta;
        return;
      case 'pending':
        setStatusPill(agencyHubConnectionStatus, 'neutral', COPY.hub.connPillPending);
        agencyHubConnectionMono.textContent = '';
        agencyHubConnectionMeta.textContent = COPY.hub.connPendingMeta;
        return;
      case 'testing':
        setStatusPill(agencyHubConnectionStatus, 'neutral', COPY.hub.connPillTesting);
        agencyHubConnectionMono.textContent = '';
        agencyHubConnectionMeta.textContent = COPY.hub.connTestingMeta;
        return;
      case 'connected':
        setStatusPill(agencyHubConnectionStatus, 'ok', COPY.hub.connPillOk);
        // The mono meta carries the receipt (when · how long · which
        // credential); a sentence would only restate the pill.
        agencyHubConnectionMono.textContent = lastConnectionCheck
          ? connectionReceipt(lastConnectionCheck)
          : (agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || '');
        agencyHubConnectionMeta.textContent = '';
        return;
      case 'failed': {
        const failedError = agencyHubConnectionFeedback.error;
        const description = getUserErrorDescription(failedError);
        // Pills speak WORDS across the whole cabinet («выдан», «есть»,
        // «активен») — the raw registry code used to land in this one (E61). It
        // keeps its place in the mono receipt at the right edge, right next to
        // the sentence that explains it. The receipt tail (when · how long ·
        // which credential) rides along since E67 retired the «Проверка»
        // diagnostics row that used to carry it for a failed check too.
        setStatusPill(agencyHubConnectionStatus, 'bad', COPY.hub.connPillFailed);
        agencyHubConnectionMono.textContent = lastConnectionCheck && !lastConnectionCheck.ok
          ? `${failedError.code} · ${connectionReceipt(lastConnectionCheck)}`
          : failedError.code;
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
    if (!hasAgencyHubConnectionInputs(
      agencyHubUrlInput.value,
      state.settings.agencyHubDeviceToken,
    )) {
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
  // settings OUTSIDE the auth FIFO — a save landing during the (up-to-5s)
  // revoke used to be able to restore a credential after the wipe.
  let quiesceSettingsBeforeSignOut: () => Promise<void> = async () => undefined;

  const runAgencyHubConnectionTest = async (options?: {
    force?: boolean;
    saveFirst?: boolean;
  }): Promise<void> => {
    const signature = buildAgencyHubConnectionSignature(
      agencyHubUrlInput.value,
      state.settings.agencyHubDeviceToken,
    );

    if (!hasAgencyHubConnectionInputs(
      agencyHubUrlInput.value,
      state.settings.agencyHubDeviceToken,
    )) {
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
      const response = await sendRuntimeRequest('testAgencyHubConnection', {
        settings: {
          agencyHubBaseUrl: agencyHubUrlInput.value,
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
        ...(response.ok ? {} : { code: (response.error ?? createUserError('hub_request_failed')).code }),
      };
      lastAgencyHubConnectionSignature = buildAgencyHubConnectionSignature(
        agencyHubUrlInput.value,
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
          description: 'Проверка связи не завершилась.',
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
  /** Has the host-permission check SETTLED at least once? `hubPermissionGranted`
   * cannot answer that — its `null` is both «never checked» and «checked, but
   * there is no origin to check» — and the Доступ diagnostics row needs the
   * difference to know whether it is still a placeholder (deep-link readiness). */
  let hubPermissionChecked = false;
  const refreshAgencyHubPermissionState = async (): Promise<void> => {
    const refreshVersion = ++agencyHubPermissionRefreshVersion;
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const originPattern = buildAgencyHubOriginPattern(normalizedBaseUrl);
    const permissionScopeNote = buildAgencyHubPermissionScopeNote(normalizedBaseUrl);
    const signedIn = state.settings.agencyHubDeviceToken.trim().length > 0;
    const permissionCheck = await getAgencyHubPermissionCheck(originPattern);
    const permissionGranted = permissionCheck.granted;

    if (refreshVersion !== agencyHubPermissionRefreshVersion) {
      return;
    }

    // The «Доступ» readiness step reads this local check — the only place that
    // knows whether Firefox granted the hub origin. Forward reference: the
    // status view is defined below and this function only ever runs later.
    hubPermissionGranted = originPattern ? permissionGranted : null;
    hubPermissionChecked = true;
    refreshStatusView();
    renderHubDiagnostics();

    if (permissionGranted) {
      agencyHubPermissionFeedback = null;
    }

    // A granted permission has nothing left to fix, and «Переподключить» on a
    // healthy row was a button whose press changed nothing (E67). The control
    // appears exactly when the pill is not «выдан» — the same condition that
    // makes the explanation sentence below it appear.
    agencyHubPermissionButton.textContent = COPY.status.grantAccess;
    agencyHubPermissionButton.disabled = !originPattern;
    agencyHubPermissionActions.hidden = permissionGranted;

    // Every branch writes the same three slots: the pill word, the mono meta at
    // the right edge (origin — only when granted), and the sentence line below
    // (empty when granted: the row already says everything).
    const setPermissionState = (
      kind: StatusPillKind,
      pillText: string,
      metaText: string,
      monoText = '',
    ): void => {
      setStatusPill(agencyHubPermissionStatus, kind, pillText);
      agencyHubPermissionMono.textContent = monoText;
      agencyHubPermissionMeta.textContent = metaText;
    };

    if (!agencyHubUrlInput.value.trim()) {
      setPermissionState('neutral', COPY.hub.permPillNoUrl, COPY.hub.permNoUrl);
      return;
    }

    if (!normalizedBaseUrl) {
      setPermissionState('warn', COPY.hub.permPillInvalidUrl, COPY.hub.permInvalidUrl);
      return;
    }

    if (!permissionGranted) {
      const permissionFeedback =
        agencyHubPermissionFeedback?.originPattern === originPattern
          ? agencyHubPermissionFeedback
          : null;

      if (permissionCheck.errorMessage) {
        setPermissionState('warn', COPY.hub.permPillCheckFailed, appendAgencyHubMeta(
          COPY.hub.permCheckError
            .replace('{origin}', originPattern ?? '')
            .replace('{message}', permissionCheck.errorMessage),
          permissionScopeNote,
        ));
        return;
      }

      if (permissionFeedback) {
        switch (permissionFeedback.kind) {
          case 'denied':
            setPermissionState('warn', COPY.hub.permPillMissing, appendAgencyHubMeta(
              COPY.hub.permDenied.replace('{origin}', originPattern ?? ''),
              permissionScopeNote,
            ));
            return;
          case 'request_error':
            setPermissionState('warn', COPY.hub.permPillMissing, appendAgencyHubMeta(
              COPY.hub.permRequestError
                .replace('{origin}', originPattern ?? '')
                .replace('{message}', permissionFeedback.errorMessage),
              permissionScopeNote,
            ));
            return;
          case 'unsupported':
            setPermissionState('warn', COPY.hub.permPillUnsupported, appendAgencyHubMeta(
              COPY.hub.permUnsupported,
              permissionScopeNote,
            ));
            return;
        }
      }

      if (typeof browser.permissions?.request !== 'function') {
        setPermissionState('warn', COPY.hub.permPillUnsupported, appendAgencyHubMeta(
          COPY.hub.permUnsupported,
          permissionScopeNote,
        ));
        return;
      }

      setPermissionState('warn', COPY.hub.permPillMissing, appendAgencyHubMeta(
        COPY.hub.permAsk.replace('{origin}', originPattern ?? ''),
        permissionScopeNote,
      ));
      return;
    }

    if (!signedIn) {
      setPermissionState('warn', COPY.hub.permPillNeedsCredential, appendAgencyHubMeta(
        COPY.hub.permNoCredential.replace('{origin}', originPattern ?? ''),
        permissionScopeNote,
      ));
      return;
    }

    // Never claim readiness here: this is a local check (permission + a stored
    // sign-in) — only the live connection test below proves sync.
    setPermissionState(
      'ok',
      COPY.hub.permPillGranted,
      appendAgencyHubMeta('', permissionScopeNote).trim(),
      originPattern ?? '',
    );
  };

  agencyHubPermissionButton.addEventListener('click', () => {
    const settingsPatch = {
      agencyHubBaseUrl: normalizeAgencyHubBaseUrl(agencyHubUrlInput.value),
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
  hubSignInUserInput.placeholder = COPY.hub.signInLoginPlaceholder;

  const hubSignInPasswordInput = document.createElement('input');
  hubSignInPasswordInput.type = 'password';
  hubSignInPasswordInput.autocomplete = 'current-password';
  hubSignInPasswordInput.className = 'chatgoose-input';
  hubSignInPasswordInput.placeholder = COPY.hub.signInPasswordPlaceholder;

  const hubSignInButton = createButton(COPY.hub.signIn, true);
  const hubSignInMeta = document.createElement('div');
  hubSignInMeta.className = 'chatgoose-meta';
  // Tagged so a test can pin WHICH line this is: it is the one line that survives
  // a repaint by itself (`renderHubSignInState` only fills it when empty), so a
  // stale sign-in message next to a signed-out pill is a real failure mode.
  hubSignInMeta.dataset.role = 'hub-signin-meta';

  let hubSignInFormExpanded = false;
  const hubReissueButton = createButton(COPY.hub.signInAgain, true);
  // «Аккаунт» opens the chatter's own cabinet on the hub — devices, password,
  // spend. It is a plain link to the SAVED address, never the form's draft: the
  // cabinet belongs to the hub that actually holds the sign-in.
  const hubAccountLink = createButton(COPY.hub.openAccount, true);
  hubAccountLink.addEventListener('click', () => {
    const baseUrl = normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl);
    if (!baseUrl) return;
    void browser.tabs.create({ url: `${baseUrl}/account` }).catch((error: unknown) => {
      console.error('Failed to open the hub account page', error);
    });
  });
  // The one page a stuck chatter is sent to — the same «Как начать» the invite
  // and the desktop app point at.
  const hubHelpLink = createButton(COPY.hub.helpSignIn, true);
  hubHelpLink.addEventListener('click', () => {
    void browser.tabs.create({ url: START_PAGE_URL }).catch((error: unknown) => {
      console.error('Failed to open the start page', error);
    });
  });
  // Destructive: wears the danger outline and lives in the bottom danger zone.
  const hubSignOutButton = createButton(COPY.hub.signOut, false, true);
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

  // «Это устройство»: whether a sign-in lives here, and since when. The block
  // says nothing about the credential — no prefix, no expiry, no renewal note
  // (E123 vocabulary). The deep-link anchor stays on the BLOCK, so CG-HUB-02/03
  // and the self-healing CG-HUB-19 all land on the sign-in the chatter must fix.
  const hubTokenBlock = document.createElement('div');
  hubTokenBlock.dataset.hubDetail = 'device-token';
  const hubTokenRow = document.createElement('div');
  hubTokenRow.className = 'chatgoose-hub-srow';
  const hubTokenLabel = document.createElement('span');
  hubTokenLabel.className = 'chatgoose-hub-srow-label';
  hubTokenLabel.textContent = COPY.hub.deviceLabel;
  const hubTokenPill = document.createElement('span');
  const hubTokenRenews = document.createElement('span');
  hubTokenRenews.className = 'chatgoose-hub-srow-meta';
  hubTokenRow.append(hubTokenLabel, hubTokenPill, hubTokenRenews);

  const hubTokenIssuedRow = document.createElement('div');
  hubTokenIssuedRow.className = 'chatgoose-hub-srow';
  const hubTokenIssuedLabel = document.createElement('span');
  hubTokenIssuedLabel.className = 'chatgoose-hub-srow-label';
  hubTokenIssuedLabel.textContent = COPY.hub.deviceSinceLabel;
  const hubTokenMeta = document.createElement('span');
  hubTokenMeta.className = 'chatgoose-hub-srow-fact';
  hubTokenIssuedRow.append(hubTokenIssuedLabel, hubTokenMeta);
  hubTokenBlock.append(hubTokenRow, hubTokenIssuedRow);

  let deviceTokenMeta: AgencyHubDeviceTokenMeta | null = null;

  /** The wire role in the chatter's own words. An unknown value (a role added
   * by a newer kernel) is shown verbatim rather than mistranslated. */
  const humanHubRole = (role: string): string => {
    switch (role) {
      case 'owner': return COPY.hub.roleOwner;
      case 'chatter': return COPY.hub.roleChatter;
      case 'team_lead': return COPY.hub.roleStaff;
      default: return role;
    }
  };

  const renderHubSignInState = (): void => {
    const hasToken = Boolean(state.settings.agencyHubDeviceToken.trim());
    // The truth about the token lives in ONE place — the Device token row below.
    // (The duplicate «Device token active ✓» pill died with the М2 re-layout;
    // the static fallback note covers the signed-in copy.)
    if (!hubSignInMeta.textContent && !hasToken) {
      // With no token the line IS the first-sign-in card's copy: who hands out
      // the credentials, and that the password is never stored on this device.
      hubSignInMeta.textContent = COPY.hub.signInHint;
    }
    // With a live token the credential form reads as unfinished business —
    // fold it away; «Перевыпустить токен» brings it back for rotation.
    // The inline grid display would override [hidden] — set both.
    hubSignInRow.hidden = hasToken && !hubSignInFormExpanded;
    hubSignInRow.style.display = hubSignInRow.hidden ? 'none' : 'grid';
    hubReissueButton.hidden = !hasToken || hubSignInFormExpanded;
    hubAccountLink.hidden = !hasToken;
    hubSignOutButton.hidden = !hasToken;
    if (hubSignOutButton.hidden) {
      hubSignOutConfirmRow.hidden = true;
    }

    // A STORED sign-in is not a LIVE one: this reads a string on disk, never
    // the kernel's opinion of it. So the pill claims custody only — «вход
    // выполнен». Liveness is the «Вы вошли как» row's word, and it comes from a
    // live read.
    setStatusPill(
      hubTokenPill,
      hasToken ? 'ok' : 'neutral',
      hasToken ? COPY.hub.deviceSignedIn : COPY.hub.deviceSignedOut,
    );
    // When the sign-in happened — one date, no identifiers. No date, no row:
    // a sign-in recorded before the metadata existed says nothing here rather
    // than holding a whole row open to explain itself (E67).
    hubTokenRenews.textContent = '';
    hubTokenIssuedRow.hidden = !hasToken || deviceTokenMeta === null;
    if (!hasToken || !deviceTokenMeta) {
      hubTokenMeta.textContent = '';
    } else {
      hubTokenMeta.textContent = COPY.hub.deviceSince.replace(
        '{date}',
        new Date(deviceTokenMeta.issuedAt).toLocaleDateString(),
      );
    }

    // The danger zone exists only while it has something to say: a sign-out to
    // offer, a confirm in progress, or an outcome line still on screen.
    hubDangerZone.hidden = hubSignOutButton.hidden
      && hubSignOutConfirmRow.hidden
      && !hubSignOutStatus.textContent;
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
        hubSignInMeta.textContent = COPY.hub.signInMissingFields;
        return;
      }
      hubSignInButton.disabled = true;
      hubSignInMeta.textContent = COPY.hub.signingIn;
      // Firefox grants `host_permissions` only at INSTALL time (bug 1893232),
      // so an install that upgraded into this release has no access to the hub
      // origin yet. «Войти» is the one user gesture the flow guarantees, so the
      // runtime request rides it — and a refusal stops here with the sentence
      // that explains it, rather than as an opaque network failure.
      const signInOrigin = buildAgencyHubOriginPattern(
        normalizeAgencyHubBaseUrl(agencyHubUrlInput.value),
      );
      if (signInOrigin && typeof browser.permissions?.request === 'function') {
        try {
          const granted = await browser.permissions.request({ origins: [signInOrigin] });
          if (!granted) {
            agencyHubPermissionFeedback = { kind: 'denied', originPattern: signInOrigin };
            hubSignInMeta.textContent = COPY.hub.permDenied.replace('{origin}', signInOrigin);
            hubSignInButton.disabled = false;
            await refreshAgencyHubPermissionState();
            return;
          }
          agencyHubPermissionFeedback = null;
        } catch (error) {
          console.error('Agency Hub permission request failed', error);
          agencyHubPermissionFeedback = {
            kind: 'request_error',
            originPattern: signInOrigin,
            errorMessage: formatAgencyHubError(error),
          };
        }
      }
      // THIS tab is about to make the background write custody. The storage event
      // for that write lands in the cross-tab fence below; the claim is held until
      // the refresh chain this path owns has run, so the fence never doubles it.
      ownCustodyWriteInFlight = true;
      // Set once the chain below took over the claim — the `finally` must then not
      // release it early.
      let ownRefreshStarted = false;
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
          hubSignInMeta.textContent = COPY.hub.signInDone;
          // The fresh token arrived OUTSIDE the save-hook path (direct
          // storage re-read), so the signature-change refresh never fires on
          // its own — without this the diagnostics card and the hero pill
          // keep claiming "not set up" next to an active token.
          ownRefreshStarted = true;
          void (async () => {
            try {
              await refreshAgencyHubPermissionState();
              await runAgencyHubConnectionTest({ force: true });
              // The freshly-issued device token makes checkIdentity return AUTH,
              // so the Доступ row (and the headline) flip in place — no reload.
              await hydrateHubStatusRows(storedHubSignature());
            } finally {
              ownCustodyWriteInFlight = false;
            }
          })().catch((error: unknown) => {
            console.error('Failed to refresh Agency Hub status after sign-in', error);
          });
        } else {
          hubSignInMeta.textContent = COPY.hub.signInFailed.replace('{message}', response.error.message);
        }
      } finally {
        if (!ownRefreshStarted) {
          ownCustodyWriteInFlight = false;
        }
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
      // The background's wipe reaches the cross-tab fence as a storage event.
      // Claim it for this path until the refresh chain below has run (see the
      // sign-in path) — otherwise both would repaint and re-check the hub.
      ownCustodyWriteInFlight = true;
      let ownRefreshStarted = false;
      try {
        // Quiesce this page's settings writer FIRST. Since v17 it owns no
        // credential of its own, but a pending snapshot can still land mid-wipe
        // and rewrite the address the revoke is aimed at. Cancel the pending
        // write and join any already-running one before the wipe begins.
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
        ownRefreshStarted = true;
        void (async () => {
          try {
            await refreshAgencyHubPermissionState();
            await runAgencyHubConnectionTest({ force: true });
            await hydrateHubStatusRows(storedHubSignature());
          } finally {
            ownCustodyWriteInFlight = false;
          }
        })().catch((error: unknown) => {
          console.error('Failed to refresh Agency Hub status after sign-out', error);
        });
      } finally {
        if (!ownRefreshStarted) {
          // Every early return above (a disposed page included) lands here.
          ownCustodyWriteInFlight = false;
        }
      }
    })();
  });

  // ── «Вход» zone card: token row, folded credential form, reissue ──
  // «Выйти» does NOT live here — destructive actions sit in their own zone at
  // the very bottom of the pane.
  const hubSignInWrap = document.createElement('div');
  hubSignInWrap.className = 'chatgoose-zone-body';
  hubReissueButton.style.justifySelf = 'start';
  const hubTokenActions = document.createElement('div');
  hubTokenActions.className = 'chatgoose-card-actions';
  hubTokenActions.append(hubReissueButton);
  // «Аккаунт» and «Нужна помощь со входом» ride one row under the form: one is
  // where the chatter manages the account he just used, the other is where he
  // goes when he could not use it.
  const hubSignInLinks = document.createElement('div');
  hubSignInLinks.className = 'chatgoose-card-actions';
  hubSignInLinks.append(hubAccountLink, hubHelpLink);
  const hubAccountHint = document.createElement('div');
  hubAccountHint.className = 'chatgoose-status-hint';
  hubAccountHint.textContent = COPY.hub.openAccountHint;
  // Order (E61): state → form → what just happened → the explanation. The
  // «Перевыпустить токен» button moved OUT of this stack and into the card head,
  // where it stops sitting between two paragraphs of explanatory text.
  hubSignInWrap.append(
    hubTokenBlock,
    hubSignInRow,
    hubSignInMeta,
    hubSignInLinks,
  );

  // The connect-zone card is assembled in the pane layout below — the base-URL
  // field it opens with is created there.
  const agencyHubConnectCard = document.createElement('div');
  agencyHubConnectCard.className = 'chatgoose-zone-body';

  // ── Danger zone: sign-out and its two-step confirm, fenced off at the bottom ──
  const hubDangerRow = document.createElement('div');
  hubDangerRow.className = 'chatgoose-hub-danger-row';
  // Consequence on the left, the button that causes it on the right.
  hubDangerRow.append(hubSignOutHint, hubSignOutButton);
  const hubDangerZone = document.createElement('div');
  hubDangerZone.className = 'chatgoose-hub-danger';
  hubDangerZone.append(hubDangerRow, hubSignOutConfirmRow, hubSignOutStatus);
  renderHubSignInState();

  // ── Hub diagnostics: dense, always-visible facts about THIS connection ──
  // Unlike the «Статус» pane's Контракт row (debug-only), every line here is
  // shown unconditionally: this card exists to be pasted into a support thread.
  //
  // `hydration: 'async'` marks a row whose value can only come from a read that
  // has not landed yet. Such a row ships `data-deeplink-ready="false"` — the
  // wave-D pattern the accounts table uses — because it pre-fills «неизвестно»,
  // and nonempty text would let an error deep link (`#hub:CG-HUB-04`,
  // `#hub:CG-HUB-05`) burn its one-shot highlight on that placeholder: the 2s
  // flash can easily expire before host access or identity hydrate, and the later
  // repaint has nothing left to re-arm. The flag flips in `renderHubDiagnostics`
  // the moment the row's own source has SETTLED (a failure is a real answer too),
  // and every paint there calls `flashPendingDeepLink`, so a late hydration fires
  // the pending flash.
  const hubDetailRow = (
    label: string,
    key: string,
    hydration: 'async' | 'sync' = 'sync',
  ): { root: HTMLElement; value: HTMLElement } => {
    const root = document.createElement('div');
    root.className = 'chatgoose-status-body';
    root.dataset.hubDetail = key;
    if (hydration === 'async') {
      root.dataset.deeplinkReady = 'false';
    }
    const labelNode = document.createElement('span');
    labelNode.className = 'chatgoose-status-label';
    labelNode.textContent = label;
    const value = document.createElement('span');
    value.className = 'chatgoose-status-fact';
    value.textContent = COPY.common.unknown;
    root.append(labelNode, value);
    return { root, value };
  };

  /** One writer for a diagnostics row's deep-link readiness: `settled` is «this
   * row's source has answered», never «the answer was good news». */
  const markHubRowHydrated = (
    row: { root: HTMLElement },
    settled: boolean,
  ): void => {
    row.root.dataset.deeplinkReady = settled ? 'true' : 'false';
  };

  const hubIdentityRow = hubDetailRow(COPY.hub.identityLabel, 'identity', 'async');
  const hubPagesRow = hubDetailRow(COPY.hub.pagesLabel, 'pages', 'async');
  const hubPagesChips = document.createElement('span');
  hubPagesChips.className = 'chatgoose-hub-chips';
  hubPagesRow.root.append(hubPagesChips);
  const hubConnectionCard = document.createElement('div');
  // `chatgoose-hub-facts` opts these two rows into the pane's fact-row rhythm
  // (E67): padding and a hairline, like every other fact row on the pane.
  hubConnectionCard.className = 'chatgoose-zone-body chatgoose-hub-facts';
  hubConnectionCard.append(hubIdentityRow.root, hubPagesRow.root);

  // ── Diagnostics rows: the «Статус»-pane anatomy — token · label · fact ·
  // mono detail at the right edge, one line per row. `set()` mirrors
  // StatusRow.set so the two vocabularies cannot drift apart. ──
  const hubDiagRow = (
    label: string,
    key: string,
    hydration: 'async' | 'sync' = 'sync',
  ): {
    root: HTMLElement;
    set: (view: { tone: BadgeTone; fact: string; detail?: string | string[] }) => void;
  } => {
    const root = document.createElement('div');
    root.className = 'chatgoose-hub-drow';
    root.dataset.hubDetail = key;
    if (hydration === 'async') {
      root.dataset.deeplinkReady = 'false';
    }
    const labelNode = document.createElement('span');
    labelNode.className = 'chatgoose-hub-drow-label';
    labelNode.textContent = label;
    const fact = document.createElement('span');
    fact.className = 'chatgoose-hub-drow-fact';
    const detail = document.createElement('div');
    detail.className = 'chatgoose-hub-drow-det';
    root.append(labelNode, fact, detail);
    return {
      root,
      set: (view) => {
        // The tone колours the FACT here — the row has no dot of its own, and
        // the mono badge it used to lead with said «OK» next to «успех» and «0»
        // next to «за сегодня 0» (E61).
        fact.textContent = view.fact;
        fact.className = view.tone === 'bad' || view.tone === 'amber'
          ? `chatgoose-hub-drow-fact chatgoose-hub-drow-fact-${view.tone}`
          : 'chatgoose-hub-drow-fact';
        // An array becomes one mono line per entry: two contract hashes do not
        // fit beside a fact on one line.
        const lines = view.detail === undefined
          ? []
          : (Array.isArray(view.detail) ? view.detail : [view.detail]);
        detail.replaceChildren(
          ...lines.map((text) => {
            const line = document.createElement('div');
            line.textContent = text;
            return line;
          }),
        );
      },
    };
  };

  // «Ядро» — the health the pane is actually about. Both facts already reach the
  // page for the «Статус» rows; the hub pane simply never said them (E61).
  const hubCoreRow = hubDiagRow(COPY.hub.coreLabel, 'core', 'async');
  const hubContractRow = hubDiagRow(COPY.hub.contractLabel, 'contract', 'async');
  const hubErrorsRow = hubDiagRow(COPY.hub.errorsLabel, 'errors', 'async');
  const hubFanSummaryRow = hubDiagRow(COPY.hub.fanSummaryLabel, 'fan-summary', 'async');
  // «Доступ к хосту» is NOT here: the same flag already paints the pill in
  // «Подключение», next to the button that fixes it. That block carries the
  // `host-access` deep-link anchor, so the anchor moved with the fact — a
  // CG-HUB-04 link highlights the fact, its explanation AND «Разрешить доступ».
  // «Проверка» is not here either (E67), for the same reason one level up: it
  // printed `lastConnectionCheck` — outcome, credential, clock, duration — which
  // the «Связь» row of «Подключение» already carries, beside the button that
  // produces it. One check, said once.
  const hubDiagnosticsCard = document.createElement('div');
  hubDiagnosticsCard.className = 'chatgoose-hub-diag';
  hubDiagnosticsCard.dataset.hubDiagnostics = 'true';
  hubDiagnosticsCard.append(
    hubCoreRow.root,
    hubContractRow.root,
    hubErrorsRow.root,
    hubFanSummaryRow.root,
  );

  // Tagged so a `CG-HUB-01` (invalid URL) deep link can highlight the field the
  // code is actually about. E123 folds it away: the fleet has ONE hub, the
  // address ships pre-filled, and a new chatter has nothing to answer here.
  const hubBaseUrlField = labeledField(COPY.hub.baseUrlLabel, agencyHubUrlInput);
  hubBaseUrlField.dataset.hubField = 'base-url';
  const hubBaseUrlHint = document.createElement('div');
  hubBaseUrlHint.className = 'chatgoose-status-hint';
  hubBaseUrlHint.textContent = COPY.hub.baseUrlHint;
  const hubAdvancedDetails = document.createElement('details');
  hubAdvancedDetails.className = 'chatgoose-details';
  hubAdvancedDetails.dataset.hubDetail = 'advanced';
  // Open only when the stored address is NOT the shipped default: someone chose
  // it deliberately, so hiding it would hide the explanation of what they see.
  hubAdvancedDetails.open =
    normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl) !== DEFAULT_AGENCY_HUB_BASE_URL;
  const hubAdvancedSummary = document.createElement('summary');
  hubAdvancedSummary.textContent = COPY.hub.advancedFold;
  hubAdvancedDetails.append(hubAdvancedSummary, hubBaseUrlField, hubBaseUrlHint);

  // Address, host access and the live test share one fate — one card. «Проверить
  // связь» is NOT in this stack: since E67 it rides the card HEAD, where the
  // «Вход» card already keeps «Перевыпустить токен» — one action pattern per
  // pane, and the card stops growing a button-height tail below its last row.
  agencyHubConnectCard.append(
    agencyHubHostAccessBlock,
    agencyHubConnectionRow.root,
    agencyHubConnectionMeta,
    hubAdvancedDetails,
  );

  // ── Pane layout (E61, columns re-cut in E67): four zone CARDS in two columns.
  // LEFT is everything about the hub — its address, whether we can reach it, and
  // how the core itself is doing. RIGHT is everything about ME — who is signed
  // in and with what credential. The E61 cut (connection+sign-in / account+
  // diagnostics) left the right column ~200px short of the left one on a signed-
  // in install, and put the two cards a chatter compares — «Связь» and
  // «Диагностика» — in different columns.
  const hubZoneCard = (title: string, body: HTMLElement, action?: HTMLElement): HTMLElement => {
    const card = document.createElement('div');
    card.className = 'chatgoose-panecard chatgoose-hub-zone';
    const head = document.createElement('div');
    head.className = 'chatgoose-panecard-head';
    const titleNode = document.createElement('span');
    titleNode.className = 'chatgoose-panecard-title';
    titleNode.textContent = title;
    head.append(titleNode);
    if (action) head.append(action);
    card.append(head, body);
    return card;
  };

  const hubHead = createPaneHead(COPY.hub.title, COPY.hub.subtitle);
  const hubGrid = document.createElement('div');
  hubGrid.className = 'chatgoose-panegrid chatgoose-panegrid-even';
  const hubLeftCol = document.createElement('div');
  hubLeftCol.className = 'chatgoose-panecol';
  const hubRightCol = document.createElement('div');
  hubRightCol.className = 'chatgoose-panecol';
  // The sign-out fence belongs to the card that owns the credential, at its
  // bottom edge — not to the pane, below everything else.
  hubSignInWrap.append(hubAccountHint, hubDangerZone);
  hubLeftCol.append(
    hubZoneCard(COPY.hub.zoneConnection, agencyHubConnectCard, agencyHubActionRow),
    hubZoneCard(COPY.hub.zoneDiagnostics, hubDiagnosticsCard),
  );
  hubRightCol.append(
    hubZoneCard(COPY.hub.zoneAccount, hubConnectionCard),
    hubZoneCard(COPY.hub.zoneSignIn, hubSignInWrap, hubTokenActions),
  );
  hubGrid.append(hubLeftCol, hubRightCol);
  agencyHubSection.append(hubHead.root, hubGrid);

  /** A cross-pane pointer. It writes the hash like every other route change —
   * the rail and a deep link stay the only two ways a pane becomes visible. */
  const paneLink = (label: string, pane: PaneKey): HTMLButtonElement => {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'chatgoose-fact-link';
    link.textContent = label;
    link.addEventListener('click', () => navigateTo(pane));
    return link;
  };

  // ─── «Статус»: read-only state rows ────────────────────────
  // Layout (E61): the pane head carries the title and «Проверить всё»; the left
  // card is the readiness headline plus the rows; the right column holds what is
  // OPEN (with the button that closes it) and what support needs.
  const statusHead = createPaneHead(
    COPY.sections.statusTitle,
    `${COPY.sections.statusHint} ${COPY.status.paneHonesty}`,
  );
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
  // — E59 amendment). It always hydrates, so it follows the debug switch live:
  // flipping the switch shows the current value, no reload needed (BL-004).
  const syncContractRowVisibility = (): void => {
    statusRows.contract.root.hidden = !debugInput.checked;
  };
  syncContractRowVisibility();
  debugInput.addEventListener('change', syncContractRowVisibility);

  // «Проверить всё» is THE action of this pane, so it alone wears the primary
  // clay — and it sits in the pane head, where a chatter looks first.
  const checkAllButton = createButton(COPY.status.checkAll);
  const copyReportButton = createButton(COPY.status.copyReport, true);
  copyReportButton.title = COPY.status.reportHonesty;
  // Both action containers keep the `chatgoose-status-actions` class: it is the
  // pane's action vocabulary, not a position.
  const statusActions = document.createElement('div');
  statusActions.className = 'chatgoose-status-actions';
  statusActions.append(checkAllButton);
  // The stamp a check leaves behind: without it a run that changed nothing was
  // indistinguishable from a run that never happened.
  const statusRefreshedTag = document.createElement('span');
  statusRefreshedTag.className = 'chatgoose-panehead-stamp';
  statusRefreshedTag.dataset.role = 'status-refreshed';
  statusRefreshedTag.textContent = COPY.status.refreshedNever;
  // Each action answers in its OWN live region. «Проверить всё» moved into the
  // pane head and left its only feedback line behind in «Поддержка», where the
  // throttle message read as a verdict on «Скопировать отчёт» — and a later
  // check silently wiped «Отчёт скопирован».
  const statusCheckNote = document.createElement('div');
  statusCheckNote.className = 'chatgoose-status-hint chatgoose-panehead-note';
  statusCheckNote.dataset.role = 'status-check-note';
  statusCheckNote.setAttribute('role', 'status');
  statusCheckNote.setAttribute('aria-live', 'polite');
  statusHead.side.append(statusRefreshedTag, statusActions, statusCheckNote);

  const statusActionNote = document.createElement('div');
  statusActionNote.className = 'chatgoose-status-hint';
  statusActionNote.dataset.role = 'status-report-note';
  statusActionNote.setAttribute('role', 'status');
  statusActionNote.setAttribute('aria-live', 'polite');
  const statusReportHint = document.createElement('div');
  statusReportHint.className = 'chatgoose-status-hint';
  statusReportHint.textContent = COPY.status.reportHint;

  const statusRowList = document.createElement('div');
  statusRowList.className = 'chatgoose-status-rows';
  statusRowList.append(
    statusRows.fansly.root,
    statusRows.hub.root,
    statusRows.access.root,
    statusRows.ai.root,
    statusRows.activity.root,
    statusRows.spenders.root,
    statusRows.contract.root,
  );

  const statusCard = document.createElement('div');
  statusCard.className = 'chatgoose-panecard';
  statusCard.append(readinessHero, statusRowList);

  // «Что мешает» — the open readiness steps, each with the button that closes
  // it. The list element itself (and its [data-readiness-step] items) is the one
  // the headline renderer already fills.
  const statusTodoCard = document.createElement('div');
  statusTodoCard.className = 'chatgoose-panecard chatgoose-todo';
  statusTodoCard.dataset.role = 'status-todo';
  statusTodoCard.hidden = true;
  const statusTodoHead = document.createElement('div');
  statusTodoHead.className = 'chatgoose-panecard-head';
  const statusTodoTitle = document.createElement('span');
  statusTodoTitle.className = 'chatgoose-panecard-title';
  statusTodoTitle.textContent = COPY.status.todoTitle;
  statusTodoHead.append(statusTodoTitle);
  statusTodoCard.append(statusTodoHead, readinessOpen);

  const statusSupportCard = document.createElement('div');
  statusSupportCard.className = 'chatgoose-panecard';
  const statusSupportHead = document.createElement('div');
  statusSupportHead.className = 'chatgoose-panecard-head';
  const statusSupportTitle = document.createElement('span');
  statusSupportTitle.className = 'chatgoose-panecard-title';
  statusSupportTitle.textContent = COPY.status.supportTitle;
  statusSupportHead.append(statusSupportTitle);
  const statusSupportFacts = document.createElement('div');
  statusSupportFacts.className = 'chatgoose-facts';
  statusSupportFacts.append(
    factRow(COPY.status.supportVersion, extensionVersion),
    factRow(COPY.status.supportSchema, `v${STORAGE_SCHEMA_VERSION}`),
  );
  const statusReportActions = document.createElement('div');
  statusReportActions.className = 'chatgoose-status-actions';
  statusReportActions.append(copyReportButton);
  statusSupportCard.append(
    statusSupportHead,
    statusSupportFacts,
    statusReportActions,
    statusActionNote,
    statusReportHint,
  );

  // The two panes a broken row is usually fixed on. The cabinet had no pointer
  // between panes at all before this.
  const statusWhereCard = document.createElement('div');
  statusWhereCard.className = 'chatgoose-panecard chatgoose-panecard-quiet';
  const statusWhereTitle = document.createElement('span');
  statusWhereTitle.className = 'chatgoose-panecard-title';
  statusWhereTitle.textContent = COPY.status.whereTitle;
  const statusWhereFacts = document.createElement('div');
  statusWhereFacts.className = 'chatgoose-facts';
  statusWhereFacts.append(
    factRow(COPY.status.whereHub, paneLink(COPY.status.whereHubLink, 'hub')),
    factRow(COPY.status.whereAccounts, paneLink(COPY.status.whereAccountsLink, 'accounts')),
  );
  statusWhereCard.append(statusWhereTitle, statusWhereFacts);

  const statusGrid = document.createElement('div');
  statusGrid.className = 'chatgoose-panegrid';
  const statusMainCol = document.createElement('div');
  statusMainCol.className = 'chatgoose-panecol';
  statusMainCol.append(statusCard);
  const statusSideCol = document.createElement('div');
  statusSideCol.className = 'chatgoose-panecol';
  statusSideCol.append(statusTodoCard, statusSupportCard, statusWhereCard);
  statusGrid.append(statusMainCol, statusSideCol);
  shell.panes.status.append(statusHead.root, statusGrid);

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
    // Fansly starts UNAVAILABLE: before the first sessions read lands, the zero
    // above is a placeholder, and a report copied in that window would otherwise
    // claim «аккаунты не обнаружены» about a snapshot nobody has taken yet. The
    // first `paintFanslyStatusRow` sets the honest value in BOTH its branches.
    unavailable: { quota: false, opsDaily: false, spenders: false, fansly: true },
    readiness: [],
  };
  // The account ids that currently have a CAPTURED session. The persona step
  // reads only this set, never every knownAccount: an offline historical
  // account with an archived mapping must not block «Готово к смене».
  let capturedAccountIds: string[] = [];
  // Until the first real datum lands — a hub identity read OR the Fansly row
  // painting — the headline stays «Проверяем…» instead of inventing a verdict.
  let fanslyRowPainted = false;
  /** When the rows last took a real answer from any of their sources. The head
   * prints it so a check that changed nothing still leaves a trace (E61). */
  let rowsRefreshedAt = 0;

  const isAccountPersonaMapped = (accountId: string): boolean => {
    const mappedKey = state.accountMappings[accountId] ?? '';
    return Boolean(mappedKey) && state.personaCatalog.some(
      (persona) => persona.key === mappedKey && persona.status === 'active',
    );
  };

  /** Every open step's way out. The pane a step is fixed on is the same one the
   * first-run checklist routes to, so the two never send a chatter to different
   * places for the same problem. */
  const READINESS_STEP_ACTIONS: Record<string, { label: string; pane: PaneKey }> = {
    hub: { label: COPY.status.stepHubAction, pane: 'hub' },
    access: { label: COPY.status.grantAccess, pane: 'hub' },
    fansly: { label: COPY.status.stepFanslyAction, pane: 'accounts' },
    persona: { label: COPY.status.stepPersonaAction, pane: 'accounts' },
  };

  const pluralizeActions = (count: number): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return COPY.status.actionWordOne;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return COPY.status.actionWordFew;
    return COPY.status.actionWordMany;
  };

  /** Whether this install actually holds a sign-in: a usable address plus the
   * stored device credential. This is the precondition for calling the hub step
   * «неизвестно» instead of «open» — with nothing stored, «войти» is true advice
   * and the step is genuinely open. Reads the PERSISTED settings on purpose: the
   * identity check runs background-side against exactly those. */
  const hubCredentialsStored = (): boolean =>
    Boolean(normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl)) &&
    Boolean(state.settings.agencyHubDeviceToken.trim());

  /** The one place that decides what a failed identity read MEANS. `unreachable`
   * and `no_permission` say nothing about the credential — the kernel is down,
   * or this browser never granted the host permission — so with credentials on
   * disk the honest answer is «проверить нельзя», not «подключить». A rejected
   * credential (`unauthorized`) and a missing one (`no_credential`,
   * `no_base_url`) stay open: those the chatter can actually fix.
   *
   * The pane also turns a rejected/malformed runtime reply into `unreachable`
   * (see `hydrateHubStatusRows`) — which is precisely why the stored-credential
   * precondition above is not optional: without it a transport hiccup on a
   * blank install would read as «неизвестно» instead of «не подключено». */
  const hubStepState = (): ReadinessStepState => {
    const identity = statusModel.identity;
    if (identity === null) return 'open';
    if (identity.ok) return 'done';
    const connectivityShaped =
      identity.reason === 'unreachable' || identity.reason === 'no_permission';
    return connectivityShaped && hubCredentialsStored() ? 'indeterminate' : 'open';
  };

  /**
   * Readiness aggregate — ACTIONABLE prerequisites only (E41). An unknown AI
   * quota, an unopened Spenders board and a quiet day are OBSERVATIONS: they
   * describe the install, they do not block a shift, and they must never turn
   * the headline red.
   */
  const buildReadiness = (): StatusReportModel['readiness'] => {
    const hubState = hubStepState();
    return [
      {
        key: 'hub',
        // An unverifiable step must not wear the CTA's phrasing: the line names
        // what is actually true — nobody could check — and carries no button.
        label: hubState === 'indeterminate' ? COPY.status.stepHubUnknown : COPY.status.stepHub,
        state: hubState,
      },
      {
        key: 'access',
        label: COPY.status.stepAccess,
        // Only a definite `false` is an open step; `null` means «not checked yet».
        // E123 adds a second condition: before the chatter has signed in, the host
        // permission is not a chore of his own — «Войти» asks Firefox for it on
        // the same click. Listing it separately on a fresh install would demand
        // an action that the very next step performs by itself.
        state: hubPermissionGranted === false && state.settings.agencyHubDeviceToken.trim()
          ? 'open'
          : 'done',
      },
      {
        key: 'fansly',
        label: COPY.status.stepFansly,
        state: capturedAccountIds.length > 0 ? 'done' : 'open',
      },
      {
        key: 'persona',
        label: COPY.status.stepPersona,
        state: capturedAccountIds.length > 0 &&
          capturedAccountIds.every((accountId) => isAccountPersonaMapped(accountId))
          ? 'done'
          : 'open',
      },
    ];
  };

  /** The checklist is live: every step reads the same sources the «Статус» rows
   * do, so a step turns green the moment its state is genuinely satisfied — and
   * only then. */
  const onboardingStepStates = (): Record<OnboardingStepKey, ReadinessStepState> => ({
    // A sign-in — stored here, or confirmed live by the kernel — is proof the
    // invite link was opened and a password set: there is no other way to get
    // one. The custody half is what lets this step go green while step 2 is
    // still «неизвестно» over a kernel outage.
    invite: state.settings.agencyHubDeviceToken.trim() || hubStepState() === 'done'
      ? 'done'
      : 'open',
    // A live identity read is the only proof a credential actually works —
    // truer than «a token string exists in storage». But the READ can fail for
    // reasons that are not this chatter's: the same three-state truth the
    // readiness hub step uses applies here, or a down kernel leaves the
    // checklist permanently unfinishable with a «Войти» nobody can satisfy.
    signIn: hubStepState(),
    fansly: capturedAccountIds.length > 0 &&
      capturedAccountIds.every((accountId) => isAccountPersonaMapped(accountId))
      ? 'done'
      : 'open',
  });

  /** True once the durable flag AND the mount snapshot agree this install has
   * never been set up. Never re-enabled afterwards: a sign-out must not put a
   * working chatter back through onboarding. */
  let onboardingVisible = false;
  /** One-shot guard around the durable stamp; re-armed if the write fails. */
  let onboardingStamping = false;

  /** How many readiness steps «Что мешает» listed at the last
   * `refreshStatusView` — open steps AND indeterminate ones, because an
   * unverifiable prerequisite is exactly «что мешает» too. Kept here because the
   * visibility of the card is not that renderer's call. */
  let listedReadinessSteps = 0;

  /** The checklist, the readiness hero and «Что мешает» are ONE decision, and
   * this is its SINGLE writer: while the checklist is up it owns the three open
   * steps (with a CTA each), so neither the hero nor the open-steps card — both
   * of which would restate exactly that list one card below — is drawn. They
   * return the moment onboarding is dismissed, or immediately on an install that
   * was never fresh. Hiding the hero alone stopped being enough when the list
   * moved out of it into its own card (E62). */
  const applyReadinessVisibility = (): void => {
    readinessHero.hidden = onboardingVisible;
    statusTodoCard.hidden = onboardingVisible || listedReadinessSteps === 0;
  };

  const renderOnboarding = (): void => {
    if (!onboardingVisible) {
      onboardingSection.hidden = true;
      applyReadinessVisibility();
      return;
    }
    const states = onboardingStepStates();
    for (const key of Object.keys(states) as OnboardingStepKey[]) {
      const step = onboardingSteps[key];
      const state = states[key];
      // `done` stays a strict claim: only a checked-and-satisfied step is green.
      step.root.dataset.done = state === 'done' ? 'true' : 'false';
      step.root.dataset.stepState = state;
      // An unverifiable step has nothing to press — «Войти» would send a chatter
      // who is already signed in back through the form over an outage that is
      // not theirs. It gets the neutral «неизвестно» instead.
      step.action.hidden = state !== 'open';
      step.done.hidden = state !== 'done';
      step.unknown.hidden = state !== 'indeterminate';
    }
    onboardingSection.hidden = false;
    applyReadinessVisibility();
    if (Object.values(states).some((state) => state !== 'done') || onboardingStamping) {
      return;
    }
    // EVERY step is green — stamp the durable flag and retire the card. The
    // strict all-done bar (not «nothing actionable») is deliberate, twice over:
    // it keeps the durable contract E59 documents (dismissedAt == every step
    // completed), and it closes a race the looser bar opened — a STALE
    // indeterminate identity combined with a freshly-granted permission could
    // dismiss the card durably before hydration, and a subsequent fresh
    // `unauthorized` could never bring it back (codex review P2 on this PR).
    // While the kernel is down the card simply stays, wearing the neutral
    // «проверить нельзя» badge — honest, and reversible the moment the kernel
    // answers. Filling in the hub URL is NOT this moment (the v1 self-cancel bug).
    onboardingStamping = true;
    void sendRuntimeRequest('dismissOnboarding')
      .then((reply) => {
        if (disposed) return;
        if (reply?.ok === true) {
          onboardingVisible = false;
          onboardingSection.hidden = true;
          // Setup is over: the headline takes the card's place immediately, and
          // it states whatever is actually true — «Готово к смене.» when every
          // step was checked, «Готовность неизвестна.» when one could not be.
          applyReadinessVisibility();
          return;
        }
        // The flag did not stick: keep the card and let a later refresh retry
        // rather than pretend onboarding is over.
        onboardingStamping = false;
      })
      .catch(() => {
        onboardingStamping = false;
      });
  };

  // The Hub pane's dense diagnostics. Everything it shows comes from the SAME
  // statusModel the Статус rows use plus the local connection/permission
  // mirrors — no extra requests, and no line invented when its source is
  // unknown.
  renderHubDiagnostics = (): void => {
    if (disposed) return;

    // «Вы вошли как …» + «Страницы Fansly» (identity)
    const identity = statusModel.identity;
    if (identity?.ok) {
      hubIdentityRow.value.textContent = COPY.hub.signedInAs
        .replace('{username}', identity.username)
        .replace('{role}', humanHubRole(identity.role));
      // A bare number: the «· {n}» template this used to share with the «Статус»
      // pane's detail read as an orphan middot after the label's grid gap (E61).
      hubPagesRow.value.textContent = String(identity.pages.length);
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
        : COPY.hub.deviceSignedOut;
      hubPagesRow.value.textContent = COPY.common.unknown;
      hubPagesChips.replaceChildren();
    }
    // Both rows read ONE source: a non-null response is the settled answer
    // (`{ok:false}` included), `null` is «the identity read has not landed».
    markHubRowHydrated(hubIdentityRow, identity !== null);
    markHubRowHydrated(hubPagesRow, identity !== null);

    // Ядро — the health response's own two facts. «Статус» says the same thing
    // one pane away; here it is the subject of the page.
    const coreHealth = statusModel.health;
    if (coreHealth === null) {
      hubCoreRow.set({ tone: 'neutral', fact: COPY.common.unknown });
    } else if (coreHealth.ok) {
      hubCoreRow.set({
        tone: coreHealth.status === 'degraded' ? 'amber' : 'green',
        fact: coreHealth.status === 'degraded' ? COPY.status.hubDegraded : COPY.status.hubUp,
        ...(coreHealth.dbLatencyMs === null
          ? {}
          : { detail: COPY.status.hubDbLatency.replace('{n}', String(coreHealth.dbLatencyMs)) }),
      });
    } else if (coreHealth.reason === 'no_base_url') {
      hubCoreRow.set({ tone: 'neutral', fact: COPY.status.hubEmpty });
    } else if (coreHealth.reason === 'no_permission') {
      hubCoreRow.set({ tone: 'amber', fact: COPY.status.hubNoPermission });
    } else {
      hubCoreRow.set({ tone: 'bad', fact: COPY.status.hubDown });
    }
    markHubRowHydrated(hubCoreRow, coreHealth !== null);
    // Settled once Firefox has answered `permissions.contains` — including the
    // «no origin to check» case, where «неизвестно» IS the final answer for the
    // address currently in the field.
    markHubRowHydrated({ root: agencyHubHostAccessBlock }, hubPermissionChecked);

    // The live check has no row of its own here (E67) — `renderAgencyHubConnection
    // State` prints it in «Подключение», outcome and receipt together.

    // Контракт SDK — ALWAYS visible here (the Статус row stays debug-only), and
    // it wears the same MATCH/DRIFT badge as the «Статус» pane's row.
    const health = statusModel.health;
    if (health?.ok) {
      const match = health.contractHash === health.sdkContractHash;
      hubContractRow.set({
        tone: match ? 'green' : 'bad',
        fact: match ? COPY.hub.contractMatches : COPY.hub.contractMismatch,
        detail: [
          health.contractHash.slice(0, 12),
          ...(health.sdkSourceCommit
            ? [COPY.status.contractSourceCommit.replace('{commit}', health.sdkSourceCommit.slice(0, 12))]
            : []),
        ],
      });
    } else {
      hubContractRow.set({ tone: 'neutral', fact: COPY.status.contractUnknown });
    }
    markHubRowHydrated(hubContractRow, health !== null);

    // Ошибки Hub — the count is stated ONCE (it used to be both the badge and
    // the fact); the list is capped at 20, so say so rather than let «за
    // сегодня: 37» look like 37 listed rows.
    const ops = statusModel.opsDaily;
    if (!ops) {
      hubErrorsRow.set({ tone: 'neutral', fact: COPY.common.unknown });
    } else {
      const last = ops.hubErrors[ops.hubErrors.length - 1];
      const detail = [
        ...(last
          ? [COPY.hub.errorsLast
              .replace('{code}', last.code)
              .replace('{time}', formatClockTime(last.at))]
          : []),
        ...(ops.hubErrorsTotal > ops.hubErrors.length ? [COPY.hub.errorsCapped] : []),
      ].join(' · ');
      hubErrorsRow.set({
        tone: ops.hubErrorsTotal > 0 ? 'amber' : 'green',
        fact: COPY.hub.errorsToday.replace('{n}', String(ops.hubErrorsTotal)),
        ...(detail ? { detail } : {}),
      });
    }

    // Fan Summary — the last push that LANDED, honest-empty otherwise.
    const push = ops?.lastSummaryPush ?? null;
    if (!ops) {
      hubFanSummaryRow.set({ tone: 'neutral', fact: COPY.common.unknown });
    } else if (push) {
      hubFanSummaryRow.set({
        tone: 'green',
        fact: COPY.hub.fanSummaryLast
          .replace('{when}', formatClockTime(push.at))
          .replace('{account}', push.accountLabel || COPY.common.unknown),
      });
    } else {
      hubFanSummaryRow.set({ tone: 'neutral', fact: COPY.hub.fanSummaryEmpty });
    }
    // Both ops-daily rows settle together: a parsed snapshot, or a read that
    // answered but could not be used (`unavailable.opsDaily`) — «неизвестно» is
    // then the final answer, not a placeholder.
    const opsSettled = ops !== null || statusModel.unavailable.opsDaily;
    markHubRowHydrated(hubErrorsRow, opsSettled);
    markHubRowHydrated(hubFanSummaryRow, opsSettled);
    // A hub-row deep link waits for these values before it highlights anything.
    flashPendingDeepLink();
  };

  const refreshStatusView = (): void => {
    if (disposed) return;
    renderHubDiagnostics();
    // Same sources, same tick: the checklist and the headline can never disagree.
    // (It also owns whether the readiness hero is visible at all — the two must
    // never state the same three steps twice.) The hero below keeps rendering
    // underneath either way, so the moment the checklist retires the headline is
    // already correct.
    renderOnboarding();
    // No datum at all yet: keep the honest loading line — never a fabricated
    // «Нужно N действий» over an install nobody has looked at.
    if (statusModel.identity === null && !fanslyRowPainted) {
      readinessHero.dataset.heroState = 'loading';
      readinessHeading.textContent = COPY.status.checkingTitle;
      readinessSub.textContent = COPY.status.checkingSubtitle;
      readinessOpen.replaceChildren();
      readinessOpen.hidden = true;
      listedReadinessSteps = 0;
      applyReadinessVisibility();
      shell.setMicro('status', null);
      return;
    }

    const readiness = buildReadiness();
    statusModel.readiness = readiness;
    const open = readiness.filter((step) => step.state === 'open');
    // Steps nobody could check. They are NOT counted as actions (there is no
    // action) and they are NOT quietly dropped either — dropping them is how a
    // dead kernel used to reach «Готово к смене · Hub на связи».
    const indeterminate = readiness.filter((step) => step.state === 'indeterminate');

    /** One row of «Что мешает». Only an OPEN step earns a button: an
     * indeterminate one is a statement, not an errand. */
    const renderReadinessItem = (step: ReadinessStep): HTMLLIElement => {
      const item = document.createElement('li');
      item.dataset.readinessStep = step.key;
      item.dataset.readinessState = step.state;
      const text = document.createElement('span');
      text.textContent = step.label;
      item.append(text);
      const cta = step.state === 'open' ? READINESS_STEP_ACTIONS[step.key] : undefined;
      if (cta) {
        const button = createButton(cta.label, true);
        button.dataset.readinessAction = step.key;
        button.addEventListener('click', () => navigateTo(cta.pane));
        item.append(button);
      }
      return item;
    };

    if (open.length === 0 && indeterminate.length === 0) {
      readinessHero.dataset.heroState = 'ready';
      readinessHeading.textContent = COPY.status.readyTitle;
      readinessSub.textContent = COPY.status.readySubtitle;
      readinessOpen.replaceChildren();
      readinessOpen.hidden = true;
    } else if (open.length === 0) {
      // Nothing to DO, nothing to CLAIM. «Готово к смене» would assert «Hub на
      // связи» about a Hub that never answered; «Нужно 1 действие» would invent
      // an errand out of an outage. The third headline says what happened.
      readinessHero.dataset.heroState = 'unknown';
      readinessHeading.textContent = COPY.status.unknownTitle;
      readinessSub.textContent = COPY.status.unknownSubtitle;
      readinessOpen.replaceChildren(...indeterminate.map(renderReadinessItem));
      readinessOpen.hidden = false;
    } else {
      readinessHero.dataset.heroState = 'route';
      readinessHeading.textContent = open.length === 1
        ? COPY.status.actionNeededTitle
        : COPY.status.actionsNeededTitle
            .replace('{n}', String(open.length))
            .replace('{word}', pluralizeActions(open.length));
      // NOT `COPY.sections.statusHint` — that sentence is already the pane's
      // subline in the head, one block above.
      readinessSub.textContent = COPY.status.readinessRouteSub;
      // Open steps first (they carry the buttons), the unverifiable ones after —
      // present in the card, absent from the count.
      readinessOpen.replaceChildren(
        ...[...open, ...indeterminate].map(renderReadinessItem),
      );
      readinessOpen.hidden = false;
    }
    // The list itself always stays current — hidden, never stale, so it is
    // already right the moment the checklist retires. WHETHER it is on screen is
    // `applyReadinessVisibility`'s call, and only its.
    listedReadinessSteps = open.length + indeterminate.length;
    applyReadinessVisibility();

    statusRefreshedTag.textContent = rowsRefreshedAt === 0
      ? COPY.status.refreshedNever
      : COPY.status.refreshedAt.replace('{time}', formatClockTime(rowsRefreshedAt));

    // The rail's «✓» is the hero's verdict in one glyph, so it answers to the
    // SAME condition: an unverifiable prerequisite withholds it exactly as it
    // withholds «Готово к смене».
    const allClear = open.length === 0 && indeterminate.length === 0;
    const micro = document.createElement('span');
    micro.className = allClear
      ? 'chatgoose-cabinet-micro-ok'
      : 'chatgoose-cabinet-micro-setup';
    micro.textContent = allClear ? COPY.rail.microOk : COPY.rail.microSetup;
    shell.setMicro('status', micro);
  };

  const paintFanslyStatusRow = (
    sessions: SessionSnapshotEntry[],
    failed: boolean,
  ): void => {
    // Either branch paints a real Fansly state — enough to lift the headline out
    // of its loading line even before the hub identity read lands.
    fanslyRowPainted = true;
    rowsRefreshedAt = Date.now();
    if (failed) {
      capturedAccountIds = [];
      statusModel.fansly = { accounts: 0, handles: [], capture: null };
      // The zero above is a placeholder, not an observation — carry the failure
      // into the model so «Скопировать отчёт» cannot turn it into a claim.
      statusModel.unavailable.fansly = true;
      statusRows.fansly.set({ tone: 'neutral', fact: COPY.status.fanslyUnavailable });
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
    // A successful re-poll clears an earlier failure: this snapshot IS an
    // observation, so the report may speak about it again.
    statusModel.unavailable.fansly = false;

    if (capturedAccountIds.length === 0) {
      statusRows.fansly.set({ tone: 'amber', fact: COPY.status.fanslyEmpty });
    } else {
      statusRows.fansly.set({
        tone: 'green',
        // The count the badge column used to carry now leads the fact.
        fact: COPY.status.fanslyWorking
          .replace('{n}', String(capturedAccountIds.length))
          .replace('{handles}', handles.join(', ')),
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
      state.settings.agencyHubDeviceToken,
    );
  // The signature of the SAVED settings — what mount, the sign-in success path,
  // the permission grant and «Проверить всё» pass as their expected snapshot (no
  // unsaved edit is in play at those moments; the form equals stored). The
  // post-persist caller instead passes its own freshly-computed signature.
  const storedHubSignature = (): string =>
    buildAgencyHubConnectionSignature(
      state.settings.agencyHubBaseUrl,
      state.settings.agencyHubDeviceToken,
    );
  // Monotonic run id: a newer run bumps it, so an older same-signature run that
  // resolves out of order drops its paint.
  let agencyHubHydrationRun = 0;
  // True while the hub/access rows show a skeleton that no run is going to
  // replace: a paint dropped by the in-flight guard below. Every later moment
  // at which the form provably equals the saved snapshot (the drop itself, a
  // persist that ran no diagnostics, the chatter coming back to the tab) heals
  // it through `healHubStatusRows` — a field moved and moved back by code (a
  // sanitising writeback, an external settings change) fires no input event
  // and no persist, so without this the rows stayed skeletons until
  // «Проверить всё» (BL-004).
  let hubStatusRowsStale = false;
  let healHubStatusRows: () => void = () => undefined;

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
      // Only the newest run speaks for the rows: an older superseded run has a
      // successor in flight that will paint (or flag) them itself.
      if (!disposed && run === agencyHubHydrationRun) {
        hubStatusRowsStale = true;
        healHubStatusRows();
      }
      return;
    }
    hubStatusRowsStale = false;
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
        tone: health.status === 'degraded' ? 'amber' : 'green',
        fact: health.status === 'degraded' ? COPY.status.hubDegraded : COPY.status.hubUp,
        detail: health.dbLatencyMs === null
          ? undefined
          : COPY.status.hubDbLatency.replace('{n}', String(health.dbLatencyMs)),
      });
    } else if (health.reason === 'no_base_url') {
      statusRows.hub.set({ tone: 'neutral', fact: COPY.status.hubEmpty });
    } else if (health.reason === 'no_permission') {
      // A fresh install has no host permission (permissions.contains defaults
      // false) — that is NOT a down core. Distinct amber badge + a grant action
      // routed to the Hub pane, so the renderer never falls through to a false
      // red «ядро недоступно».
      statusRows.hub.set({ tone: 'amber', fact: COPY.status.hubNoPermission });
      const grant = createButton(COPY.status.grantAccess, true);
      grant.addEventListener('click', () => navigateTo('hub'));
      statusRows.hub.setAction(grant);
    } else {
      statusRows.hub.set({ tone: 'bad', fact: COPY.status.hubDown });
    }

    // Доступ — CREDENTIAL validity only, never a hub-health verdict.
    statusRows.access.setAction(null);
    if (identity.ok) {
      statusRows.access.set({
        tone: 'green',
        fact: `${identity.username} · ${identity.role}`,
        // Its own key — the «· {n}» template this row used to borrow read as a
        // separator after the Hub pane's label and as an orphan at this edge.
        detail: COPY.status.accessPages.replace('{n}', String(identity.pages.length)),
      });
    } else if (identity.reason === 'unauthorized') {
      statusRows.access.set({ tone: 'bad', fact: COPY.status.accessRejected });
      const reLogin = createButton(COPY.status.reLogin, true);
      reLogin.addEventListener('click', () => navigateTo('hub'));
      statusRows.access.setAction(reLogin);
    } else if (identity.reason === 'no_credential') {
      statusRows.access.set({ tone: 'neutral', fact: COPY.status.accessEmpty });
    } else if (identity.reason === 'no_base_url') {
      // A credential is present but the hub address is blank — nothing is wrong
      // with the credential, so the badge stays neutral and the fact names the
      // real gap (the missing address), not a false «нет credential».
      statusRows.access.set({ tone: 'neutral', fact: COPY.status.hubEmpty });
    } else {
      // no_permission and unreachable are HUB-health conditions, not credential
      // verdicts — the Доступ badge stays neutral (the blocker is surfaced on
      // the Hub row), never a red «нет credential».
      statusRows.access.set({ tone: 'neutral', fact: COPY.status.accessUnknown });
    }

    // Контракт (debug-only here; derived from the same health response)
    if (health.ok) {
      const match = health.contractHash === health.sdkContractHash;
      statusRows.contract.set({
        tone: match ? 'green' : 'bad',
        fact: match ? COPY.status.contractMatches : COPY.status.contractDrift,
        detail: health.sdkSourceCommit
          ? COPY.status.contractSourceCommit.replace('{commit}', health.sdkSourceCommit.slice(0, 12))
          : undefined,
      });
    } else {
      statusRows.contract.set({ tone: 'neutral', fact: COPY.status.contractUnknown });
    }

    rowsRefreshedAt = Date.now();
    refreshStatusView();
  };

  /** Repaint rows a dropped paint left as skeletons — only when the live form
   * equals the saved snapshot, so the run is one the guards will let paint. A
   * form that is mid-edit is left to that edit's own persist. */
  healHubStatusRows = (): void => {
    if (disposed || !hubStatusRowsStale) return;
    const stored = storedHubSignature();
    if (currentHubSignature() !== stored) return;
    hubStatusRowsStale = false;
    void hydrateHubStatusRows(stored).catch((error: unknown) => {
      console.error('Failed to repaint Agency Hub status', error);
    });
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
    // A read is usable only when it SETTLED and its reply parsed. `[]` and `null`
    // are what these sources honestly look like on a quiet day, so falling back to
    // them after a transport failure would have the pane assert «сегодня генераций
    // не было» and «доска ещё не открывалась» about state nobody could read — and
    // a REJECTION is not the only way to get there: a stale background (or a
    // truncated frame) fulfils with `undefined`, which the parsers would otherwise
    // collapse into the very same empty. Both failures now paint «недоступно»,
    // while a genuinely empty map / null observation stays an honest empty. Each
    // verdict travels into the row AND into the support report.
    const quotaParsed = quotaResult.status === 'fulfilled'
      ? parseQuotaEntries(quotaResult.value)
      : UNUSABLE_REPLY;
    const spendersParsed = spendersResult.status === 'fulfilled'
      ? parseSpendersObservation(spendersResult.value)
      : UNUSABLE_REPLY;
    const opsParsed = opsResult.status === 'fulfilled'
      ? parseOpsDailySnapshot(opsResult.value)
      : UNUSABLE_REPLY;
    const quotaUnavailable = !quotaParsed.ok;
    const spendersUnavailable = !spendersParsed.ok;
    const opsUnavailable = !opsParsed.ok;
    statusModel.unavailable = {
      ...statusModel.unavailable,
      quota: quotaUnavailable,
      opsDaily: opsUnavailable,
      spenders: spendersUnavailable,
    };
    const spenders = spendersParsed.ok ? spendersParsed.value : null;
    const opsDaily = opsParsed.ok ? opsParsed.value : null;

    // Квота AI — requests per page only; NEVER a micro-USD figure (E14). An
    // empty map is «no observation today», not «no quota».
    const quotaEntries = quotaParsed.ok ? quotaParsed.value : [];
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
      statusRows.ai.set({ tone: 'neutral', fact: COPY.status.aiUnavailable });
    } else if (worstFirst.length === 0) {
      statusRows.ai.set({ tone: 'neutral', fact: COPY.status.aiEmpty });
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
        // The number used to live in the badge while the fact was a LEGEND
        // («по страницам · худшая первой»). With the badge gone the row states
        // the worst page and its remainder; the full ledger stays below.
        fact = COPY.status.aiWorst
          .replace('{page}', worstFirst[0]?.pageLabel ?? '')
          .replace('{n}', String(remaining));
      }
      statusRows.ai.set({ tone, fact });
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
      statusRows.activity.set({ tone: 'neutral', fact: COPY.status.activityUnavailable });
    } else if (!lastGeneration) {
      statusRows.activity.set({ tone: 'neutral', fact: COPY.status.activityEmpty });
      statusRows.activity.setDetailLines(
        opsDaily && opsDaily.hubErrorsTotal > 0
          ? [COPY.status.activityHubErrors.replace('{n}', String(opsDaily.hubErrorsTotal))]
          : [],
      );
    } else {
      const label = lastGeneration.accountLabel || shortenAccountId(lastGeneration.accountId);
      statusRows.activity.set({
        tone: 'neutral',
        // The clock time used to be this row's badge.
        fact: COPY.status.activityLast
          .replace('{time}', formatClockTime(lastGeneration.at))
          .replace('{feature}', lastGeneration.feature)
          .replace('{account}', label),
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
      statusRows.spenders.set({ tone: 'neutral', fact: COPY.status.spendersUnavailable });
    } else if (!spenders) {
      statusRows.spenders.set({ tone: 'neutral', fact: COPY.status.spendersEmpty });
    } else if (spenders.outcome === 'fail') {
      statusRows.spenders.set({ tone: 'bad', fact: COPY.status.spendersFail });
    } else {
      // Four states, four facts — the badge column used to print «FLAG OFF» for
      // two of them, so the token alone could not be read.
      const byState: Record<SpendersStreamState, { tone: BadgeTone; fact: string }> = {
        ramped: { tone: 'green', fact: COPY.status.spendersRamped },
        flag_off: { tone: 'neutral', fact: COPY.status.spendersFlagOff },
        not_allowlisted: { tone: 'amber', fact: COPY.status.spendersNotAllowlisted },
        unsupported_platform: { tone: 'neutral', fact: COPY.status.spendersUnsupported },
      };
      // FLAG OFF only from a real flag_off observation; a null streamState on a
      // successful outcome is «not yet observed», so keep the neutral em-dash.
      statusRows.spenders.set(
        spenders.streamState
          ? byState[spenders.streamState]
          : { tone: 'neutral', fact: COPY.status.spendersEmpty },
      );
    }

    // The fact says WHAT the projection is doing; these say WHICH page it is
    // about and how old the data is. Both are stated for a failed observation
    // too — «сборка не удалась» without a page names nothing. No manual
    // clearing: `set()` above already emptied the detail slot.
    if (spenders) {
      const spendersDetails: string[] = [];
      if (spenders.pageLabel) {
        spendersDetails.push(COPY.status.spendersPageScope.replace('{page}', spenders.pageLabel));
      }
      // typeof, not `!== null`: an observation stored before this field existed
      // comes back as undefined, and `undefined !== null` is true — which would
      // have reached the formatter with NaN and printed «данные свежие» over a
      // stalled feed.
      if (typeof spenders.builtAt === 'number') {
        const age = formatSpendersDataAge(spenders.builtAt);
        if (age !== null) spendersDetails.push(age);
      }
      if (spendersDetails.length > 0) statusRows.spenders.setDetailLines(spendersDetails);
    }

    rowsRefreshedAt = Date.now();
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
      statusCheckNote.textContent = COPY.status.checkAllThrottled;
      return;
    }
    lastCheckAllAt = now;
    checkAllButton.disabled = true;
    checkAllButton.textContent = COPY.status.checkAllRunning;
    statusCheckNote.textContent = '';
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

  // ─── Save whisper ────────────────────────────────────────
  // (The banner above used to say «AI Models» — that section left with Stage 32.)

  const saveToast = document.createElement('div');
  saveToast.className = 'chatgoose-save-toast';
  saveToast.setAttribute('role', 'status');
  saveToast.setAttribute('aria-live', 'polite');
  const saveToastMessage = document.createElement('span');
  const retrySaveButton = createButton(COPY.common.retrySave, true);
  retrySaveButton.hidden = true;
  saveToast.append(saveToastMessage, retrySaveButton);
  document.body.append(saveToast);
  let saveToastTimer: number | undefined;
  const showSaveToast = (failed = false): void => {
    saveToastMessage.textContent = failed ? COPY.common.saveFailed : COPY.common.saved;
    saveToast.dataset.failed = String(failed);
    retrySaveButton.hidden = !failed;
    saveToast.classList.add('chatgoose-save-toast-visible');
    if (saveToastTimer !== undefined) {
      window.clearTimeout(saveToastTimer);
    }
    if (!failed) {
      saveToastTimer = window.setTimeout(() => {
        saveToast.classList.remove('chatgoose-save-toast-visible');
      }, 1600);
    }
  };
  cleanupTasks.push(() => {
    if (saveToastTimer !== undefined) {
      window.clearTimeout(saveToastTimer);
    }
    saveToast.remove();
  });

  const settingsFormSignature = (): string => JSON.stringify([
    getSelectedTheme(),
    toolbarHintsInput.checked,
    agencyHubUrlInput.value,
    quickInput.value,
    pingInput.value,
    improveInput.value,
    deepInput.value,
    coachHistoryInput.value,
    coachRecapSelect.value,
    debugInput.checked,
  ]);
  const collectSettingsPatch = (): Partial<Settings> => {
    const patch: Partial<Settings> = {
      uiTheme: getSelectedTheme(),
      showToolbarHints: toolbarHintsInput.checked,
      agencyHubBaseUrl: agencyHubUrlInput.value,
      quickMessageCount: Number(quickInput.value),
      pingMessageCount: Number(pingInput.value),
      improveMessageCount: Number(improveInput.value),
      deepMessageCount: Number(deepInput.value),
      coachHistoryLimit: Number(coachHistoryInput.value),
      coachAutoRecap: coachRecapSelect.value as Settings['coachAutoRecap'],
      debugMode: debugInput.checked,
    };
    // v17 (E123): this page persists NO credential. The sign-in lives in its own
    // custody key, written background-side inside the FIFO — so a stale Options
    // tab saving a theme can no longer race a sign-in at all.
    return patch;
  };

  const mergeSavedFormSettings = (savedSettings: Settings): Settings => ({
    ...savedSettings,
    // The sign-in is background-issued and never form-owned. Preserve a newer
    // sign-in/re-read if an older local write acknowledges afterwards.
    agencyHubDeviceToken: state.settings.agencyHubDeviceToken,
  });

  let settingsSaveChain: Promise<void> | null = null;
  let settingsDirty = false;
  let settingsSnapshotVersion = 0;
  let settingsSaveChainSignature: string | null = null;
  const queueSettingsSave = (): Promise<void> => {
    if (futureSchemaObserved !== null) {
      settingsDirty = false;
      return Promise.resolve();
    }
    // Capture the fields now, then serialize storage writes. A slow previous
    // storage read must not be allowed to finish after a newer edit and put an
    // older form snapshot back into storage.
    const formSignature = settingsFormSignature();
    const patch = collectSettingsPatch();
    const snapshotVersion = ++settingsSnapshotVersion;
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
      const mergedSettings = mergeSavedFormSettings(savedSettings);
      if (snapshotVersion !== settingsSnapshotVersion) {
        return;
      }
      state.settings = mergedSettings;

      if (disposed) {
        return;
      }
      showSaveToast();

      agencyHubUrlInput.value = mergedSettings.agencyHubBaseUrl;

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
        updateCoachRecapSegment();
        updateCoachRecapWarning();
      }
      if (document.activeElement !== toolbarHintsInput) {
        toolbarHintsInput.checked = mergedSettings.showToolbarHints;
      }

      const hubSignature = buildAgencyHubConnectionSignature(
        mergedSettings.agencyHubBaseUrl,
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
      } else {
        // The connection test already knows this hub, so no diagnostics run —
        // but rows a dropped paint left as skeletons get their repaint here,
        // against the snapshot this persist just wrote (BL-004).
        healHubStatusRows();
      }
    };
    const execution = settingsSaveChain
      ? settingsSaveChain.then(persist)
      : persist();
    const settled = execution
      .catch((error: unknown) => {
        console.error('Failed to save Settings changes', error);
        // Only the newest snapshot may report failure or restore dirty state.
        // An older rejected write must not undo a newer successful save, nor
        // revive a snapshot invalidated by the custody/future-schema fence.
        if (!disposed && futureSchemaObserved === null && snapshotVersion === settingsSnapshotVersion) {
          settingsDirty = true;
          showSaveToast(true);
        }
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
  retrySaveButton.addEventListener('click', () => {
    saveSettingsDebounced.cancel();
    retrySaveButton.disabled = true;
    void queueSettingsSave().finally(() => {
      retrySaveButton.disabled = false;
    });
  });
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
    return queueSettingsSave();
  };

  quiesceSettingsBeforeSignOut = async (): Promise<void> => {
    // DROP the pending snapshot rather than flushing it: it may still rewrite
    // the hub address the sign-out's revoke is aimed at. Clearing the dirty flag
    // also stops a queued blur from re-scheduling the same snapshot.
    saveSettingsDebounced.cancel();
    settingsDirty = false;
    // An already-running write is past cancellation — join it so the wipe
    // strictly follows it. `settingsSaveChain` never rejects (queueSettingsSave
    // attaches its own catch), so this cannot fail the sign-out.
    await (settingsSaveChain ?? Promise.resolve());
  };

  // Toggle the cost warning the moment the picker changes, ahead of any save,
  // and keep its message tracking the deep-window field as the chatter types.
  // The segment repaints from the same event — the hidden select stays the one
  // source of truth for every writer (buttons, tests, cross-tab merge).
  coachRecapSelect.addEventListener('change', updateCoachRecapWarning);
  coachRecapSelect.addEventListener('change', updateCoachRecapSegment);
  deepInput.addEventListener('input', updateCoachRecapWarning);

  [
    ...themeRadios,
    toolbarHintsInput,
    agencyHubUrlInput,
    quickInput,
    pingInput,
    improveInput,
    deepInput,
    coachHistoryInput,
    coachRecapSelect,
    debugInput,
  ].forEach((element) => {
    element.addEventListener('input', () => {
      scheduleSettingsSave();
    });
    element.addEventListener('change', () => {
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

  // ─── «Персоны» (server-owned catalog, metadata only) ────────
  /** accountId → the label the «Аккаунты» pane shows for it. Filled by the
   * accounts renderer (the ONE place that resolves a name), read by the persona
   * rows so both panes call an account the same thing (E62). A plain Map, not a
   * read of `accountsView`: this renderer runs at build time, long before that
   * binding is initialised. */
  const accountLabelIndex = new Map<string, string>();
  const accountLabelFor = (accountId: string): string =>
    accountLabelIndex.get(accountId) ?? shortenAccountId(accountId);

  const personalitiesSection = document.createElement('section');
  personalitiesSection.className = 'chatgoose-pane-plain';
  const personasHead = createPaneHead(COPY.personas.title, COPY.personas.subtitle);
  const personasToAccounts = createButton(COPY.personas.toAccounts, true);
  personasToAccounts.addEventListener('click', () => navigateTo('accounts'));
  personasHead.side.append(personasToAccounts);
  const personalitiesList = document.createElement('div');
  personalitiesList.className = 'chatgoose-persona-rows';
  let refreshAccountMappingPersonalityOptions: (() => void) | null = null;

  // Date of the last saved catalog contents, not the latest fetch.
  const personaCatalogRow = document.createElement('div');
  personaCatalogRow.dataset.role = 'persona-catalog';
  personaCatalogRow.className = 'chatgoose-fact';
  const personaCatalogLabel = document.createElement('span');
  personaCatalogLabel.className = 'chatgoose-fact-k';
  // Background write suppression makes this a content snapshot date.
  personaCatalogLabel.textContent = COPY.personas.catalogUpdatedLabel;
  const personaCatalogFact = document.createElement('span');
  personaCatalogFact.className = 'chatgoose-fact-v';
  personaCatalogRow.append(personaCatalogLabel, personaCatalogFact);
  // There is no standalone «refetch the catalog» operation, and inventing one is
  // out of scope: the background re-reads the catalog after a SUCCESSFUL
  // connection test, so the button says exactly what it does.
  const personaRefreshButton = createButton(COPY.personas.catalogRefresh, true);
  personaRefreshButton.dataset.role = 'persona-catalog-refresh';
  const personaRefreshResult = document.createElement('div');
  personaRefreshResult.className = 'chatgoose-status-hint';
  personaRefreshResult.dataset.role = 'persona-refresh-result';
  personaRefreshResult.setAttribute('role', 'status');
  personaRefreshResult.setAttribute('aria-live', 'polite');
  personaRefreshButton.addEventListener('click', () => {
    personaRefreshButton.disabled = true;
    personaRefreshResult.textContent = COPY.personas.catalogChecking;
    void (async () => {
      try {
        await refreshAgencyHubPermissionState();
        if (!disposed) {
          await runAgencyHubConnectionTest({ force: true, saveFirst: true });
          if (disposed) return;
          // The RPC confirms connectivity, not catalog freshness: the catalog
          // controller keeps failed polls out of this response. State only the
          // outcome we know, beside the button that requested it.
          personaRefreshResult.textContent = agencyHubConnectionFeedback.kind === 'connected'
            ? COPY.personas.catalogConnectionChecked
            : agencyHubConnectionFeedback.kind === 'failed'
              ? agencyHubConnectionFeedback.error.message
              : agencyHubConnectionFeedback.kind === 'testing' || agencyHubConnectionFeedback.kind === 'pending'
                ? COPY.personas.catalogChecking
                : COPY.personas.catalogConnectionSetup;
        }
      } catch (error) {
        console.error('Failed to check Agency Hub from the persona catalog', error);
        if (!disposed) personaRefreshResult.textContent = createUserError('hub_request_failed').message;
      } finally {
        if (!disposed) personaRefreshButton.disabled = false;
      }
    })();
  });
  const personaRefreshHint = document.createElement('span');
  personaRefreshHint.className = 'chatgoose-status-hint';
  personaRefreshHint.textContent = COPY.personas.catalogRefreshHint;
  const personaActions = document.createElement('div');
  personaActions.className = 'chatgoose-status-actions';
  personaActions.append(personaRefreshButton);
  // Which hub this catalog came from — in memory since wave C, shown nowhere.
  const personaSourceFact = factRow(COPY.personas.catalogSourceLabel, '');
  // A hub address can be long (an origin plus a path). It WRAPS rather than
  // pushing the card past a narrow window — an ellipsis would hide exactly the
  // path that tells two agencies on one host apart.
  const personaSourceValue = personaSourceFact.querySelector<HTMLElement>('.chatgoose-fact-v');
  personaSourceValue?.classList.add('chatgoose-fact-v-wrap');

  const renderPersonaCatalog = (): void => {
    // A repopulated catalog can flip the «персона назначена» step: a mapping
    // migrateState hid may now resolve to an active persona.
    refreshStatusView();
    // Rail micro: active personas, or «—» while the catalog has never been read
    // for these credentials. «0» there would claim the hub answered «none».
    const activePersonas = state.personaCatalog.filter(
      (persona) => persona.status === 'active',
    ).length;
    const personasMicro = document.createElement('span');
    personasMicro.textContent = state.personaCatalogFetchedAt === null && activePersonas === 0
      ? COPY.rail.microNone
      : String(activePersonas);
    shell.setMicro('personas', personasMicro);
    const changedDate = formatCatalogChangedDate(state.personaCatalogFetchedAt);
    personaCatalogFact.textContent = changedDate ?? COPY.personas.catalogNever;
    // Identical catalog polls deliberately do not write storage. This stamp
    // dates the saved contents, never the last successful connectivity check;
    // the former amber age badge falsely diagnosed an unchanged catalog as stale.
    // Which hub this catalog belongs to. The source is «baseUrl|hash» — only the
    // address half is meaningful to a chatter, and the hash is a credential
    // fingerprint that has no business on screen. The address is shown WHOLE:
    // `normalizeAgencyHubBaseUrl` deliberately keeps a non-root path, so two hubs
    // on one host («…/agency-a», «…/agency-b») collapsed into one line when this
    // printed the host alone.
    if (personaSourceValue) {
      const storedBaseUrl = normalizeAgencyHubBaseUrl(
        state.personaCatalogSource?.split('|')[0] ?? '',
      );
      personaSourceValue.textContent = storedBaseUrl || COPY.personas.catalogSourceUnknown;
    }
    personalitiesList.replaceChildren();
    const rows = buildPersonaRowViews(state.personaCatalog, state.accountMappings);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.dataset.role = 'persona-empty';
      empty.style.color = 'var(--chatgoose-ink-mid)';
      // A non-empty raw catalog with zero rows means every persona is archived AND
      // unreferenced — a real catalog, so «каталог пуст» would be false. Only a
      // genuinely empty raw catalog defers to the credential/fetch classifier.
      empty.textContent = state.personaCatalog.length > 0
        ? COPY.personas.emptyAllArchived
        : PERSONA_EMPTY_COPY[classifyPersonaEmptyState({
            currentSource: personaCatalogSource(state.settings),
            storedSource: state.personaCatalogSource,
            fetchedAt: state.personaCatalogFetchedAt,
          })];
      personalitiesList.append(empty);
      flashPendingDeepLink();
      return;
    }
    for (const view of rows) {
      const row = document.createElement('div');
      row.className = view.archived
        ? 'chatgoose-persona-row chatgoose-persona-row-archived'
        : 'chatgoose-persona-row';
      row.dataset.personaKey = view.key;
      const head = document.createElement('div');
      head.className = 'chatgoose-persona-head';
      const name = document.createElement('span');
      name.className = 'chatgoose-persona-name';
      name.textContent = view.displayName;
      head.append(name);
      if (view.builtin) {
        head.append(createBadge(COPY.personas.builtInBadge, 'neutral'));
      }
      head.append(
        createBadge(`${COPY.personas.versionPrefix}${view.version}`, 'neutral', true),
      );
      // Right cluster: only what asks for an ACTION. The mono «аккаунтов · N»
      // that used to lead it counted the very chips printed on the line below —
      // and those chips are never truncated, so the number restated what was
      // already fully on screen. The count moved into the chips' own caption
      // (E67), which frees this cluster for the archived instruction alone.
      const side = document.createElement('span');
      side.className = 'chatgoose-persona-side';
      if (view.archived) {
        // Only reachable while a mapping still points at it — amber, because the
        // one useful instruction is «pick a replacement».
        side.append(createBadge(COPY.personas.archivedMapped, 'amber'));
      }
      row.append(head, side);
      // Which accounts sit on this persona. The map was already in memory; the
      // pane used to collapse it into the count above and drop the names (E62).
      const mapped = document.createElement('div');
      mapped.className = 'chatgoose-persona-mapped';
      mapped.dataset.role = 'persona-mapped';
      const mappedLabel = document.createElement('span');
      mappedLabel.className = 'chatgoose-persona-mapped-cap';
      mappedLabel.textContent = view.accountIds.length > 0
        ? COPY.personas.mappedLabel.replace('{n}', String(view.accountCount))
        : COPY.personas.mappedEmpty;
      mapped.append(mappedLabel);
      for (const accountId of view.accountIds) {
        const chip = createBadge(accountLabelFor(accountId), 'neutral');
        chip.dataset.personaAccount = accountId;
        mapped.append(chip);
      }
      row.append(mapped);
      personalitiesList.append(row);
    }
    flashPendingDeepLink();
  };

  const preservationNote = document.createElement('div');
  preservationNote.textContent = COPY.personas.legacyNote;
  preservationNote.style.color = 'var(--chatgoose-ink-mid)';
  preservationNote.style.fontSize = '13px';
  // The legacy archive is a rarely-needed escape hatch — folded away so it does
  // not compete with the live catalog above it.
  const preservationFold = document.createElement('details');
  preservationFold.className = 'chatgoose-details';
  preservationFold.dataset.role = 'persona-legacy-fold';
  const preservationSummary = document.createElement('summary');
  preservationSummary.textContent = COPY.personas.legacyFold;
  preservationFold.append(
    preservationSummary,
    preservationNote,
    createLegacyPersonaExportControls(),
  );

  renderPersonaCatalog();

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
      return;
    }
    if (settingsDirty) {
      settingsDirty = false;
      const patch = collectSettingsPatch();
      const snapshotVersion = ++settingsSnapshotVersion;
      void saveSettings(patch, state.settings, {
        observedSchemaVersion: futureSchemaObserved ?? state.schemaVersion,
      })
        .then((savedSettings) => {
          if (snapshotVersion === settingsSnapshotVersion) {
            state.settings = mergeSavedFormSettings(savedSettings);
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to save Settings changes on pagehide', error);
        });
    }
  };
  window.addEventListener('pagehide', handlePageHide);
  cleanupTasks.push(() => window.removeEventListener('pagehide', handlePageHide));

  // Layout (E62): the catalog itself on the left, its provenance and the rarely
  // used archive on the right — the pane used to be one strip and 700px of air.
  const personasGrid = document.createElement('div');
  personasGrid.className = 'chatgoose-panegrid';
  const personasMainCol = document.createElement('div');
  personasMainCol.className = 'chatgoose-panecol';
  const personasListCard = document.createElement('div');
  personasListCard.className = 'chatgoose-panecard';
  const personasListHead = document.createElement('div');
  personasListHead.className = 'chatgoose-panecard-head';
  const personasListTitle = document.createElement('span');
  personasListTitle.className = 'chatgoose-panecard-title';
  personasListTitle.textContent = COPY.personas.listCardTitle;
  personasListHead.append(personasListTitle);
  personasListCard.append(personasListHead, personalitiesList);
  personasMainCol.append(personasListCard);

  const personasSideCol = document.createElement('div');
  personasSideCol.className = 'chatgoose-panecol';
  const personaCatalogCard = document.createElement('div');
  personaCatalogCard.className = 'chatgoose-panecard';
  const personaCatalogHead = document.createElement('div');
  personaCatalogHead.className = 'chatgoose-panecard-head';
  const personaCatalogTitle = document.createElement('span');
  personaCatalogTitle.className = 'chatgoose-panecard-title';
  personaCatalogTitle.textContent = COPY.personas.catalogCardTitle;
  personaCatalogHead.append(personaCatalogTitle);
  const personaCatalogFacts = document.createElement('div');
  personaCatalogFacts.className = 'chatgoose-facts';
  personaCatalogFacts.append(personaCatalogRow, personaSourceFact);
  personaCatalogCard.append(
    personaCatalogHead,
    personaCatalogFacts,
    personaActions,
    personaRefreshResult,
    personaRefreshHint,
  );
  const personaArchiveCard = document.createElement('div');
  personaArchiveCard.className = 'chatgoose-panecard chatgoose-panecard-quiet';
  personaArchiveCard.append(preservationFold);
  // The archive is about PERSONAS, so it stands under the persona list, not
  // under the sync card (E67). It also evens the columns: with a small catalog
  // the main column used to run out ~120px before the side one.
  personasMainCol.append(personaArchiveCard);
  personasSideCol.append(personaCatalogCard);
  personasGrid.append(personasMainCol, personasSideCol);
  personalitiesSection.append(personasHead.root, personasGrid);

  // ─── «Аккаунты» ────────────────────────────────────────────
  const mappingsSection = document.createElement('section');
  mappingsSection.className = 'chatgoose-pane-plain';
  mappingsSection.dataset.sessionHydration = 'loading';
  // Own node rather than createSection's description: the subtitle counts live
  // accounts, so it has to be repaintable. The live counter is a chip in the
  // pane head; the two instructions it used to be glued to are the pane's
  // subtitle now (E62).
  const accountsSubtitle = document.createElement('div');
  accountsSubtitle.className = 'chatgoose-chip';
  accountsSubtitle.dataset.role = 'accounts-subtitle';
  accountsSubtitle.textContent = COPY.accounts.subtitle
    .replace('{live}', '—')
    .replace('{total}', '—');
  const mappingsTable = document.createElement('div');
  mappingsTable.className = 'chatgoose-account-rows';
  // A `no_mapping` deep link points here, and this table is the slowest thing on
  // the page (the sessions snapshot resolves identities against Fansly first).
  // Until it has been painted from a real result it is NOT a highlight target —
  // the loading line below would otherwise consume the one-shot flash.
  mappingsTable.dataset.deeplinkReady = 'false';
  const mappingsLoading = document.createElement('div');
  mappingsLoading.textContent = COPY.accounts.loading;
  mappingsLoading.style.color = 'var(--chatgoose-ink-mid)';
  mappingsTable.append(mappingsLoading);
  // Static tail: the honesty note about what «в работе» means and that labels
  // never leave this device. Outside `mappingsTable`, which is replaced wholesale
  // on every repaint.
  const accountsHint = document.createElement('div');
  accountsHint.className = 'chatgoose-status-hint';
  accountsHint.textContent = COPY.accounts.hint;
  // The rare-question tail lives in the tooltip, not in a third visible line.
  accountsHint.title = COPY.accounts.hintNeverSeen;
  const accountsHead = createPaneHead(COPY.accounts.title, COPY.accounts.paneSubtitle);
  accountsHead.side.append(accountsSubtitle);
  const accountsCard = document.createElement('div');
  accountsCard.className = 'chatgoose-panecard';
  accountsCard.append(mappingsTable);
  const accountsBody = document.createElement('div');
  accountsBody.className = 'chatgoose-panegrid-single';
  accountsBody.append(accountsCard, accountsHint);
  mappingsSection.append(accountsHead.root, accountsBody);
  // One section per pane — the rail carries the reading order now (setup
  // order: the hub everything depends on, then the personas it serves, then
  // the accounts they map to, then the local-only settings).
  shell.panes.hub.append(agencyHubSection);
  shell.panes.personas.append(personalitiesSection);
  shell.panes.accounts.append(mappingsSection);
  shell.panes.generation.append(apiSection);
  shell.panes.hotkeys.append(hotkeysSection);
  shell.panes.appearance.append(appearanceSection);

  // ─── Диплинк из ошибки ─────────────────────────────────────
  // A deep link (`#hub:CG-HUB-04`) carries the code that sent the chatter here.
  // Two things follow: one line naming it — text read straight from the E58
  // registry, never restated in COPY — and a one-shot highlight of the row that
  // code is about. The highlight is PENDING until its target is actually there:
  // the diagnostics and the account rows hydrate asynchronously, and flashing an
  // empty container would point at nothing.
  const DEEP_LINK_TARGETS: Record<string, string> = {
    'CG-HUB-01': '[data-hub-field="base-url"]',
    'CG-HUB-02': '[data-hub-detail="device-token"]',
    'CG-HUB-03': '[data-hub-detail="device-token"]',
    'CG-HUB-04': '[data-hub-detail="host-access"]',
    'CG-HUB-05': '[data-hub-detail="pages"]',
    // The sign-in family (E123) all points at the one block that fixes it.
    'CG-HUB-17': '[data-hub-detail="device-token"]',
    'CG-HUB-18': '[data-hub-detail="device-token"]',
    'CG-HUB-19': '[data-hub-detail="device-token"]',
    'CG-FLOW-01': '.chatgoose-persona-rows',
    'CG-FLOW-02': '.chatgoose-account-rows',
  };
  const deepLinkNote = document.createElement('div');
  deepLinkNote.className = 'chatgoose-deeplink';
  deepLinkNote.dataset.role = 'deeplink-note';
  let pendingDeepLink: { code: string; pane: PaneKey } | null = null;
  let flashedElement: HTMLElement | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFlash = (): void => {
    if (flashTimer !== undefined) {
      clearTimeout(flashTimer);
      flashTimer = undefined;
    }
    flashedElement?.classList.remove('chatgoose-flash');
    flashedElement = null;
  };
  cleanupTasks.push(clearFlash);

  /** Is this target REALLY there, or is it still a placeholder?
   *
   * Nonempty text is not proof: the accounts table ships with a loading line, so
   * an arm against it would burn the one-shot highlight on «Загружаем…» and let
   * the 2s flash expire long before `getSessionsSnapshot` (up to 5s) paints the
   * rows — with `pendingDeepLink` already consumed, the later repaint could not
   * re-arm. A container that hydrates asynchronously therefore declares its own
   * readiness (`data-deeplink-ready`), and only that answer counts. */
  const isDeepLinkTargetReady = (target: HTMLElement): boolean => {
    const declared = target.dataset.deeplinkReady;
    if (declared !== undefined) {
      return declared === 'true';
    }
    // Rows that paint synchronously from a single value: text IS the hydration
    // signal (a diagnostics row before its first paint is empty).
    return Boolean(target.textContent?.trim());
  };

  flashPendingDeepLink = (): void => {
    if (disposed || !pendingDeepLink) return;
    const selector = DEEP_LINK_TARGETS[pendingDeepLink.code];
    if (!selector) {
      // A settings-linked code with no row of its own: the note above is the
      // whole answer, so stop waiting for a target that does not exist.
      pendingDeepLink = null;
      return;
    }
    const target = shell.panes[pendingDeepLink.pane].querySelector<HTMLElement>(selector);
    // Not hydrated yet — keep waiting. Every repaint that can produce the target
    // calls back into here, so a late hydration still fires the pending flash.
    if (!target || !isDeepLinkTargetReady(target)) return;
    pendingDeepLink = null;
    const sameTarget = flashedElement === target;
    clearFlash();
    if (sameTarget) {
      // Two codes in a row landing on one row: remove+add within a frame is a
      // no-op for the CSS animation, so force a style flush between them so
      // the second flash is visible (BL-006).
      void target.offsetWidth;
    }
    flashedElement = target;
    target.classList.add('chatgoose-flash');
    flashTimer = setTimeout(() => {
      if (flashedElement === target) clearFlash();
    }, DEEP_LINK_FLASH_MS);
  };

  const armDeepLink = (): void => {
    if (disposed) return;
    // A new deep link supersedes the previous one — including its highlight.
    clearFlash();
    pendingDeepLink = null;
    deepLinkNote.remove();
    const route = parseOptionsHash(window.location.hash);
    const key = route.code ? findErrorKeyByCode(route.code) : null;
    if (!route.code || !key) {
      // No code, or a code this build does not know: the pane still opens (the
      // shell already did that) — we just have nothing honest to say about it.
      return;
    }
    const registryEntry = getErrorMessage(key);
    deepLinkNote.textContent = `${registryEntry.code} · ${
      getUserErrorDescription(registryEntry) ?? registryEntry.message
    }`;
    shell.panes[route.pane].prepend(deepLinkNote);
    pendingDeepLink = { code: route.code, pane: route.pane };
    flashPendingDeepLink();
  };

  // A deep link into an ALREADY OPEN settings tab arrives as a hash change (the
  // background re-points the one tab rather than opening a second one), so this
  // has to re-arm — not just run at mount.
  const handleDeepLinkHashChange = (): void => armDeepLink();
  window.addEventListener('hashchange', handleDeepLinkHashChange);
  cleanupTasks.push(() => {
    window.removeEventListener('hashchange', handleDeepLinkHashChange);
  });
  armDeepLink();


  cleanupTasks.push(() => {
    disposed = true;
  });

  /** The background's honest account view: durable presence, local labels, tab
   * attribution and the observed kernel page. `null` until the first read lands
   * (or after one fails) — the renderer then degrades to what this page can see
   * on its own instead of showing nothing. */
  let accountsView: AccountsView | null = null;
  const refreshAccountsView = async (): Promise<void> => {
    try {
      const reply = await sendRuntimeRequest('getAccountsView');
      if (disposed) return;
      const parsed = asAccountsView(reply);
      // A malformed reply keeps the previous view rather than blanking the pane:
      // stale-but-real beats invented-empty.
      if (parsed) accountsView = parsed;
    } catch (error) {
      console.error('Failed to read the Fansly accounts view', error);
    }
  };

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
  // carries only what the select can't: session state and a dead mapping.
  const renderMappingInfo = (
    info: HTMLElement,
    view: { label: string; usable: boolean } | null,
    connected: boolean,
    accountId: string,
    personaMapped: boolean,
  ): void => {
    // No «в работе» pill any more: the rows are grouped BY state (E62), so the
    // group caption says it once for its whole block instead of once per row.
    // What stays here is only what carries a problem or an action.
    void connected;
    info.replaceChildren();
    if (view && !view.usable) {
      // An archived persona still mapped: the only useful instruction is «pick a
      // replacement», which is exactly what the Персоны pane says too.
      info.append(createStatusPill('warn', COPY.personas.archivedMapped));
    }
    if (!personaMapped) {
      // Amber, not red: nothing is broken — the account simply cannot generate
      // until a persona is chosen, and the hint says exactly that. Owned here,
      // not appended after the fact, so a catalog or mapping refresh repaints
      // it with the rest of the pills instead of wiping it (BL-005).
      const aiOff = createBadge(COPY.accounts.personaUnmapped, 'amber');
      aiOff.dataset.accountAiOff = accountId;
      aiOff.title = COPY.accounts.personaUnmappedHint;
      info.append(aiOff);
    }
  };
  const populateMappingSelect = (
    select: HTMLSelectElement,
    selectedPersonalityId: string,
    views: PersonalityMappingView[],
  ): { label: string; usable: boolean } | null => {
    const unmapped = document.createElement('option');
    unmapped.value = '';
    unmapped.textContent = COPY.accounts.personaSelectNone;
    select.replaceChildren(unmapped);
    for (const view of views) {
      const option = document.createElement('option');
      option.value = view.personality.key;
      option.textContent = view.usable
        ? view.label
        : `${view.label} · ${COPY.accounts.personaSelectArchived}`;
      option.disabled = !view.usable;
      select.append(option);
    }

    const selectedView = views.find(
      (view) => view.personality.key === selectedPersonalityId,
    ) ?? null;
    if (selectedPersonalityId && !selectedView) {
      const missing = document.createElement('option');
      missing.value = selectedPersonalityId;
      missing.textContent = COPY.accounts.personaSelectMissing.replace(
        '{key}',
        selectedPersonalityId,
      );
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
        // The badge follows the value the select shows: a pending pick counts
        // as mapped only once it lands in storage (which re-runs this refresh).
        renderMappingInfo(
          info,
          selectedView,
          select.dataset.connected === 'true',
          accountId,
          isAccountPersonaMapped(accountId),
        );
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
      settingsSnapshotVersion += 1;
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
    /**
     * A CUSTODY key changed on disk and this document did not write it.
     *
     * The single-options-tab guarantee covers only the paths `openOptions` owns —
     * a manually opened second settings tab is real. Without this fence that tab
     * keeps the wiped credential in `state.settings` after the other tab's
     * «Выйти»: it still shows «вход выполнен», still offers «Выйти», and a
     * connection test from it would send a credential that no longer exists on
     * disk. So the fresh custody value is applied here and the hub state is
     * repainted from it (signed-out, after an external wipe).
     *
     * Since v17 the page owns no credential FIELD of its own, so there is no
     * unsaved draft to protect — only state to apply. The live slot still
     * arrives as an EMPTY STRING on a wipe, never as a removed key.
     */
    const applyExternalCustodyChange = (persisted: Settings): void => {
      if (persisted.agencyHubDeviceToken === state.settings.agencyHubDeviceToken) {
        // Already in sync — this tab's own write echoed back, or an unrelated
        // (settings / persona-catalog) event. Nothing to apply, and no reason to
        // re-run the hub checks the writing path already fired. This equality
        // check is the ONLY no-op suppressor, which is why the caller may invoke
        // this on every applied read instead of trusting a per-event flag.
        return;
      }
      const tokenChanged = true;
      state.settings = {
        ...state.settings,
        agencyHubDeviceToken: persisted.agencyHubDeviceToken,
      };
      // Immediate, synchronous truth: the token pill, the folded sign-in form and
      // the «Выйти» button all read `state.settings` only. The meta line is
      // cleared first: `renderHubSignInState` only fills it when empty, so a stale
      // «Device token abc… issued (expires …)» would otherwise sit next to a
      // signed-out pill.
      hubSignInMeta.textContent = '';
      renderHubSignInState();
      renderAgencyHubConnectionState();
      if (ownCustodyWriteInFlight) {
        // THIS tab's own sign-in / re-issue / «Выйти» is mid-flight (the storage
        // event can beat its RPC reply). The state above is applied — it is real —
        // but that path owns the permission → connection-test → hydrate chain and
        // runs it exactly once; doing it here too would double every hub check.
        return;
      }
      void (async () => {
        if (tokenChanged) {
          // The metadata record travels WITH the token (one atomic write on
          // issue, removed on sign-out), so re-read it instead of describing a
          // token that is gone.
          deviceTokenMeta = asDeviceTokenMeta(
            await sendRuntimeRequest('getAgencyHubDeviceTokenMeta').catch(() => null),
          );
          if (disposed) return;
          renderHubSignInState();
        }
        await refreshAgencyHubPermissionState();
        if (disposed) return;
        // NO local connection test here. This tab's form may hold a different
        // base URL (the blob field the fence deliberately does not touch) or an
        // uncommitted key draft, so a forced test would mix sources — worst
        // case sending the OTHER hub's fresh token to the URL still shown in
        // THIS form. The tab that performed the custody write already ran the
        // checks; this tab only READS: the status rows below hydrate from the
        // stored snapshot, and the «Проверка» line keeps honestly reporting the
        // last test this tab itself ran.
        await hydrateHubStatusRows(storedHubSignature());
      })().catch((error: unknown) => {
        console.error('Failed to apply an external Agency Hub custody change', error);
      });
    };

    const handleCatalogStorageChange = (
      changes: Record<string, browser.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (
        areaName !== 'local' ||
        !(
          changes.settings ||
          changes[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_SOURCE_STORAGE_KEY] ||
          changes[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY] ||
          // A persona assignment writes ONLY this key, and the persona rows
          // state a per-persona account list — without it those rows kept a
          // stale count until the next reload (E62 / BL-005).
          changes.accountMappings
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
        state.accountMappings = refreshedState.accountMappings;
        renderPersonaCatalog();
        refreshAccountMappingPersonalityOptions?.();
        // Custody is applied from the STATE this generation read, never gated on
        // which event started it. A per-event `custodyChanged` flag belongs to the
        // read that the generation guard above then DISCARDS: a settings or
        // persona-catalog event landing one tick after a wipe would supersede the
        // custody read, and the surviving callback (flag `false`) would leave this
        // tab holding a revoked token until the next custody event. The equality
        // check inside is what suppresses the no-ops.
        applyExternalCustodyChange(refreshedState.settings);
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

  /**
   * The rows to paint. The background's view is authoritative — it is the only
   * side that knows durable presence, local labels and tab attribution.
   *
   * Without it (an older background, a rejected read) the pane degrades to what
   * this page can see by itself: the known accounts and the live snapshot. The
   * degraded rows deliberately claim LESS — no observed page, no tab id — and
   * they get a FOURTH state the contract does not have: an account the live
   * snapshot says nothing about is 'unknown', not 'never'. The state is a group
   * CAPTION since E62, and «Сессий не было» over a row is a verdict only durable
   * presence can support.
   */
  const buildAccountRowViews = (
    sessions: SessionSnapshotEntry[],
  ): AccountRowView[] => {
    if (accountsView) {
      return accountsView.accounts;
    }
    const lookup = buildSessionLookup(sessions);
    return state.knownAccounts.map((accountId) => {
      const session = lookup.get(accountId);
      return {
        accountId,
        label: formatAccountHeading(accountId, session),
        localLabel: null,
        // A snapshot entry IS an observation: connected means live, and a
        // disconnected entry still carries the moment it was last seen. No entry
        // at all means this page has nothing to say.
        state: session ? (session.connected ? 'live' : 'seen') : 'unknown',
        lastSeenAt: session?.lastSeenAt ?? null,
        tabId: null,
        personaMapped: isAccountPersonaMapped(accountId),
        observedPage: null,
      } satisfies AccountRowView;
    });
  };

  const renderAccountMappings = (
    sessions: SessionSnapshotEntry[],
    hydrationFailed: boolean,
  ): void => {
    const personalityViews = buildPersonalityMappingViews();
    const rows = buildAccountRowViews(sessions);
    // One vocabulary for an account across the cabinet: the persona rows render
    // these labels as chips (E62). Repaint them only when a label actually
    // changed — this renderer runs on every session re-poll.
    let labelsChanged = false;
    for (const view of rows) {
      if (accountLabelIndex.get(view.accountId) !== view.label) {
        accountLabelIndex.set(view.accountId, view.label);
        labelsChanged = true;
      }
    }

    mappingsTable.replaceChildren();
    mappingsSection.dataset.sessionHydration = hydrationFailed ? 'failed' : 'ready';
    // The loading line is gone: whatever this paint produced — rows, the fresh
    // empty state, or the refresh-failed warning — is the real answer, so a
    // pending deep-link highlight may now land on it.
    mappingsTable.dataset.deeplinkReady = 'true';

    // An empty table after a FAILED refresh is not «fresh»: the rows may well
    // exist, this page just could not read them. The ghosts below are gated the
    // same way; the chip must agree with them.
    accountsSubtitle.textContent = rows.length === 0
      ? (hydrationFailed ? COPY.accounts.subtitleUnavailable : COPY.accounts.subtitleFresh)
      : COPY.accounts.subtitle
          .replace('{live}', String(rows.filter((row) => row.state === 'live').length))
          .replace('{total}', String(rows.length));

    if (hydrationFailed) {
      const warning = document.createElement('div');
      warning.textContent = COPY.accounts.refreshFailed;
      warning.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(warning);
    }

    // Groups (E62): «В работе», «Видели раньше», «Сессий не было» — a caption
    // and a count per block, and an empty group is not drawn at all. Six
    // identical tiles used to carry their state in an 8px dot alone.
    const groupCaptions: Record<AccountRowView['state'], string> = {
      live: COPY.accounts.groupLive,
      seen: COPY.accounts.groupSeen,
      never: COPY.accounts.groupNever,
      unknown: COPY.accounts.groupUnknown,
    };
    const groupLists = new Map<AccountRowView['state'], HTMLElement>();
    const groupFor = (state: AccountRowView['state']): HTMLElement => {
      const existing = groupLists.get(state);
      if (existing) return existing;
      const group = document.createElement('div');
      group.className = 'chatgoose-account-group';
      group.dataset.accountGroup = state;
      const caption = document.createElement('div');
      caption.className = 'chatgoose-account-group-cap';
      const captionText = document.createElement('span');
      captionText.textContent = groupCaptions[state];
      const captionCount = document.createElement('span');
      captionCount.dataset.role = 'account-group-count';
      captionCount.textContent = String(rows.filter((row) => row.state === state).length);
      // The count sits beside the word it counts (E67). `space-between` used to
      // fling it to the card's right edge — ~850px from its caption on a wide
      // window, where a lone digit reads as anything but a group size.
      caption.append(captionText, captionCount);
      const list = document.createElement('div');
      // NOT `chatgoose-account-rows`: that class is the TABLE's, and it is what
      // the `CG-FLOW-02` deep link selects with `querySelector` — wearing it here
      // too made the highlight land on the right element by DOM order alone.
      list.className = 'chatgoose-account-group-rows';
      group.append(caption, list);
      mappingsTable.append(group);
      groupLists.set(state, list);
      return list;
    };

    rows.forEach((view) => {
      const accountId = view.accountId;
      const isLive = view.state === 'live';
      const row = document.createElement('div');
      row.className = 'chatgoose-account-row';
      row.dataset.accountMappingRow = accountId;
      row.dataset.accountState = view.state;

      // Two-line anatomy (М2): dot · name-cluster · state pills on line one;
      // mono meta «full id · fact» · persona select on line two. Placement is
      // the row grid's job — there are no wrapper divs to fight.
      const dot = document.createElement('span');
      dot.className = 'chatgoose-account-dot';

      const head = document.createElement('div');
      head.className = 'chatgoose-account-head';
      // No name resolved and no label: the heading IS the id (E62). Since E67 it
      // is the FULL id and it is the copy button — the row used to print the
      // shortened id as its heading and the full one again on the line below,
      // the same number twice. A named row is untouched: name above, id below.
      const unnamed = !view.localLabel && view.label === shortenAccountId(accountId);
      const labelNode = unnamed
        ? createCopyableId(accountId)
        : document.createElement('span');
      labelNode.classList.add('chatgoose-account-label');
      if (view.localLabel) {
        // Say WHOSE name this is — a local label must never be mistaken for the
        // model's real Fansly handle.
        labelNode.textContent = view.label;
        labelNode.title = COPY.accounts.renameLocalTitle;
        labelNode.dataset.accountLocalLabel = 'true';
      } else if (unnamed) {
        labelNode.classList.add('chatgoose-mono', 'chatgoose-account-label-id');
        labelNode.dataset.accountUnnamed = 'true';
      } else {
        labelNode.textContent = view.label;
      }
      head.append(labelNode);

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'chatgoose-account-rename';
      renameButton.dataset.accountRename = accountId;
      renameButton.title = COPY.accounts.renameTitle;
      renameButton.setAttribute('aria-label', COPY.accounts.renameTitle);
      // An unnamed row gets the invitation spelled out; a named one keeps the
      // quiet pencil (E62).
      renameButton.textContent = labelNode.dataset.accountUnnamed === 'true'
        ? `✎ ${COPY.accounts.renameInvite}`
        : '✎';
      head.append(renameButton);

      // Inline label editor: Enter saves through the runtime operation (the only
      // writer of the labels key), Esc — and a blur — cancel. There is no second
      // save path, so a half-typed label can never be persisted by accident.
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'chatgoose-input chatgoose-account-rename-input';
      labelInput.dataset.accountLabelInput = accountId;
      labelInput.placeholder = COPY.accounts.renameEmpty;
      labelInput.setAttribute('aria-label', `${COPY.accounts.renameTitle}: ${view.label}`);
      labelInput.title = COPY.accounts.renameHint;
      labelInput.maxLength = 60;
      labelInput.value = view.localLabel ?? '';
      labelInput.hidden = true;

      const editFeedback = document.createElement('div');
      editFeedback.className = 'chatgoose-meta';
      editFeedback.style.gridColumn = '1 / -1';
      editFeedback.setAttribute('role', 'status');
      editFeedback.dataset.role = 'account-edit-feedback';
      editFeedback.hidden = true;

      const closeEditor = (): void => {
        labelInput.hidden = true;
        labelInput.value = view.localLabel ?? '';
        renameButton.hidden = false;
        labelNode.hidden = false;
        editFeedback.hidden = true;
      };
      renameButton.addEventListener('click', () => {
        labelNode.hidden = true;
        renameButton.hidden = true;
        labelInput.hidden = false;
        editFeedback.textContent = COPY.accounts.renameHint;
        editFeedback.hidden = false;
        labelInput.focus();
        labelInput.select();
      });
      labelInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeEditor();
          renameButton.focus();
          return;
        }
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        const nextLabel = labelInput.value;
        labelInput.disabled = true;
        void (async () => {
          try {
            const reply = await sendRuntimeRequest('setAccountLabel', {
              accountId,
              label: nextLabel,
            });
            if (reply?.ok !== true) {
              throw new Error('Account label write was not acknowledged');
            }
            await refreshAccountsView();
            if (!disposed) {
              // The rebuilt row carries the new label; this editor goes with it.
              renderAccountMappings(sessions, hydrationFailed);
              // The editor the chatter was typing in is gone with the old row;
              // keyboard users land on the rebuilt row's rename control, not
              // on <body> (BL-005).
              const rebuiltRename = Array.from(
                mappingsTable.querySelectorAll<HTMLButtonElement>('[data-account-rename]'),
              ).find((node) => node.dataset.accountRename === accountId);
              rebuiltRename?.focus();
            }
          } catch (error) {
            // Keep the editor open with the typed text: a rename that did not
            // stick must not look like it did.
            console.error('Failed to save the local account label', error);
            if (!disposed) {
              labelInput.disabled = false;
              editFeedback.textContent = `${COPY.common.saveFailed}. ${COPY.accounts.renameHint}`;
              editFeedback.hidden = false;
              labelInput.focus();
            }
          }
        })();
      });
      labelInput.addEventListener('blur', () => {
        if (!labelInput.disabled) closeEditor();
      });
      head.append(labelInput);

      // The fact line must never contradict the caption above it: an 'unknown'
      // row says it knows nothing rather than borrowing «сессий не было».
      //
      // A row in the «Сессий не было» group says NOTHING here (E67): its state
      // fact was that caption, word for word, once per row. The 'unknown' group
      // keeps its line — «о прошлых сессиях этот браузер не знает» explains the
      // caption rather than repeating it — and «в работе» / «видели раньше» keep
      // theirs because they add a fact (which tab, and when).
      const stateFact = isLive
        ? COPY.accounts.subTabActive
        : view.lastSeenAt !== null
          ? COPY.accounts.subSeenAt.replace('{when}', formatSeenWhen(view.lastSeenAt))
          : view.state === 'unknown'
            ? COPY.accounts.subStateUnknown
            : null;
      const facts: string[] = [
        ...(stateFact === null ? [] : [stateFact]),
        ...(view.observedPage
          ? [COPY.accounts.corePage.replace('{page}', view.observedPage)]
          : []),
      ];

      const sub = document.createElement('div');
      sub.className = 'chatgoose-account-sub';
      // The id lives on ONE line per row: the heading when the row has no name,
      // this line otherwise.
      if (!unnamed) {
        sub.append(createCopyableId(accountId));
        if (facts.length > 0) {
          const subSep = document.createElement('span');
          subSep.className = 'chatgoose-account-sub-sep';
          subSep.setAttribute('aria-hidden', 'true');
          subSep.textContent = '·';
          sub.append(subSep);
        }
      }
      if (facts.length > 0) {
        const factsNode = document.createElement('span');
        factsNode.className = 'chatgoose-account-facts';
        factsNode.dataset.role = 'account-facts';
        factsNode.textContent = facts.join(' · ');
        sub.append(factsNode);
      }
      // Nothing left for line two — an unnamed, never-seen account with no page
      // observed. The row IS one line then, and the persona select joins the
      // action cluster rather than floating beside a hole.
      const oneLine = sub.childElementCount === 0;

      const select = document.createElement('select');
      select.className = 'chatgoose-select';
      select.dataset.accountId = accountId;
      select.dataset.connected = isLive ? 'true' : 'false';
      select.setAttribute(
        'aria-label',
        COPY.accounts.personaSelectAria.replace('{label}', view.label),
      );
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
            // A fresh mapping flips this row's «AI отключён», so the background
            // view has to be re-read before the rows are rebuilt.
            await refreshAccountsView();
            if (disposed) {
              return;
            }
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
              editFeedback.textContent = COPY.common.saveFailed;
              editFeedback.hidden = false;
              refreshAccountMappingPersonalityOptions?.();
            }
          }
        })();
      });

      const actions = document.createElement('div');
      actions.className = 'chatgoose-account-actions';
      const info = document.createElement('div');
      info.dataset.role = 'mapping-info';
      info.className = 'chatgoose-account-pills';
      renderMappingInfo(info, mappedView, isLive, accountId, view.personaMapped);
      actions.append(info);
      // «к вкладке» ONLY for a live row: the tab id comes from the worker's
      // in-memory capture map, and after a restart there is nothing to focus.
      if (isLive && view.tabId !== null) {
        const focusTab = createButton(COPY.accounts.focusTab, true);
        focusTab.dataset.accountFocusTab = accountId;
        focusTab.addEventListener('click', () => {
          const clearFocusFailure = (): void => {
            // This slot also belongs to rename/mapping. A successful tab
            // action must not erase their independently reported failures.
            if (editFeedback.textContent === COPY.accounts.focusTabFailed) {
              editFeedback.textContent = '';
              editFeedback.hidden = true;
            }
          };
          clearFocusFailure();
          focusTab.disabled = true;
          const showFocusFailure = (): void => {
            if (disposed) return;
            editFeedback.textContent = COPY.accounts.focusTabFailed;
            editFeedback.hidden = false;
          };
          void sendRuntimeRequest('focusAccountTab', { accountId })
            .then((reply) => {
              if (!reply?.ok) showFocusFailure();
              else clearFocusFailure();
            })
            .catch((error: unknown) => {
              console.error('Failed to focus the Fansly tab', error);
              showFocusFailure();
            })
            .finally(() => {
              focusTab.disabled = false;
            });
        });
        actions.append(focusTab);
      }

      if (oneLine) {
        row.classList.add('chatgoose-account-row-1line');
        actions.append(select);
        row.append(dot, head, actions);
      } else {
        row.append(dot, head, actions, sub, select);
      }
      row.append(editFeedback);
      groupFor(view.state).append(row);
    });

    // `!hydrationFailed` is load-bearing: «появится само» is a promise about a
    // read that SUCCEEDED and found nothing. Painting it next to the
    // refresh-failed warning would answer «not yet» for a question nobody could
    // answer — the failure is the whole honest state here.
    if (rows.length === 0 && !hydrationFailed) {
      // Two ghost rows: the shape of what will appear on its own once Fansly is
      // open, so an empty pane reads as «not yet» instead of «broken». Pure
      // decoration — `aria-hidden`, no controls, nothing to click.
      for (let index = 0; index < 2; index += 1) {
        const ghost = document.createElement('div');
        ghost.className = 'chatgoose-account-row chatgoose-account-row-ghost';
        ghost.dataset.role = 'account-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        const ghostDot = document.createElement('span');
        ghostDot.className = 'chatgoose-account-dot';
        const ghostHead = document.createElement('span');
        ghostHead.className = 'chatgoose-ghost-bar chatgoose-ghost-bar-head';
        const ghostSub = document.createElement('span');
        ghostSub.className = 'chatgoose-ghost-bar chatgoose-ghost-bar-sub';
        const ghostSelect = document.createElement('span');
        ghostSelect.className = 'chatgoose-ghost-bar chatgoose-ghost-bar-select';
        // Same grid slots as a real row: dot · head bar / sub bar · select bar.
        ghost.append(ghostDot, ghostHead, ghostSub, ghostSelect);
        mappingsTable.append(ghost);
      }
      const empty = document.createElement('div');
      empty.dataset.role = 'accounts-empty';
      empty.textContent = COPY.accounts.emptyFresh;
      empty.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(empty);
    }

    // Rail micro: how many accounts this browser knows about at all. «0» is the
    // honest fresh-install answer — a local count, never a promise about the
    // model being online.
    const accountsMicro = document.createElement('span');
    accountsMicro.textContent = String(rows.length);
    shell.setMicro('accounts', accountsMicro);
    // The rows a `no_mapping` deep link points at exist only now.
    flashPendingDeepLink();

    // Open fansly.com tabs nothing is attributed to. An aggregate, never a
    // per-account claim: after a worker restart the capture map is gone, and
    // re-deriving it would mean reading Fansly (DP 1-B).
    const unattributed = accountsView?.unattributedFanslyTabs ?? 0;
    if (unattributed > 0) {
      const tabsLine = document.createElement('div');
      tabsLine.dataset.role = 'accounts-unattributed';
      tabsLine.className = 'chatgoose-account-unattributed';
      tabsLine.textContent = COPY.accounts.unattributedTabs.replace(
        '{n}',
        String(unattributed),
      );
      mappingsTable.append(tabsLine);
    }
    // The persona rows show these labels as chips; repaint them when a label
    // actually changed (this renderer also runs on every session re-poll).
    if (labelsChanged) renderPersonaCatalog();
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
      // Read the accounts view AFTER the snapshot resolved: `getSessionsSnapshot`
      // owns the identity rekey background-side, and the rekey is what moves
      // presence and labels onto the canonical id. Reading earlier could paint a
      // legacy row that no longer exists. A local read — no hub, no Fansly.
      await refreshAccountsView();
      if (disposed) {
        return;
      }
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
      healHubStatusRows();
    }
  };
  const handleFocusRepoll = (): void => {
    void repollSessions();
    healHubStatusRows();
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
  // The durable half of the first-run predicate, and — because it decides
  // whether the «нов.» dot is appropriate at all — the changelog's seen-version
  // read behind it. Both are read once per mount: the onboarding flag only ever
  // goes from «null» to «stamped», the local half was captured at mount, and the
  // running version cannot change under an open page.
  void (async () => {
    const onboarding = asOnboardingSnapshot(
      await sendRuntimeRequest('getOnboardingState').catch(() => null),
    );
    if (disposed) return;
    onboardingVisible = onboarding !== null &&
      onboarding.dismissedAt === null &&
      freshAtMount;
    renderOnboarding();

    const seen = await sendRuntimeRequest('getLastSeenVersion').catch(() => null);
    if (disposed) return;
    const lastSeenVersion = typeof (seen as { lastSeenVersion?: unknown } | null)?.lastSeenVersion === 'string'
      ? (seen as { lastSeenVersion: string }).lastSeenVersion
      : null;
    if (lastSeenVersion === extensionVersion) {
      return;
    }
    if (onboardingVisible) {
      // A first run has nothing to catch up on: record the version silently so
      // the NEXT update is the one that earns the dot.
      markVersionSeen();
      return;
    }
    railFoot.setUnseen(true);
  })();
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

void render();
