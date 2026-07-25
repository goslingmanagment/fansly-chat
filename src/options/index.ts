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
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  CHANGELOG_URL,
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
  // The bare id, no «ID аккаунта:» prefix — the meta line it lives in is the
  // ONE place the full id appears (the heading carries the name or short id).
  const idText = fullId;
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

  root.replaceChildren();
  root.style.paddingBottom = '24px';

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
    changelogUrl: CHANGELOG_URL,
    onOpenChangelog: () => {
      markVersionSeen();
      void browser.tabs.create({ url: CHANGELOG_URL }).catch((error: unknown) => {
        console.error('Failed to open the changelog', error);
      });
    },
  });

  // ─── Первый запуск: чеклист ────────────────────────────────
  // Shown only on a genuinely untouched install, and it stays until every step
  // is really done. The «fresh» half of the predicate is captured HERE, from the
  // mount snapshot, before any hydration can mutate it — and the durable half
  // (`chatgoose:onboarding`) arrives from the background below. Deliberately not
  // derived from live form state: in v1 typing the hub URL dismissed the
  // checklist that was still explaining the next two steps.
  const freshAtMount =
    !state.settings.agencyHubDeviceToken.trim() &&
    !state.settings.agencyHubApiKey.trim() &&
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

  type OnboardingStepKey = 'access' | 'signIn' | 'fansly';
  const buildOnboardingStep = (
    key: OnboardingStepKey,
    ordinal: number,
    title: string,
    hint: string,
    actionLabel: string,
    onAction: () => void,
  ): { root: HTMLElement; action: HTMLButtonElement; done: HTMLElement } => {
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
    item.append(number, body, action, done);
    onboardingList.append(item);
    return { root: item, action, done };
  };

  // Step order per E41's own flow: the host permission comes BEFORE sign-in,
  // because sign-in cannot pass without it (a `no_permission` hub read is not a
  // credential problem, and telling the chatter to log in first would send them
  // into the failure).
  const onboardingSteps: Record<
    OnboardingStepKey,
    { root: HTMLElement; action: HTMLButtonElement; done: HTMLElement }
  > = {
    access: buildOnboardingStep(
      'access',
      1,
      COPY.onboarding.step1Title,
      COPY.onboarding.step1Hint,
      COPY.onboarding.step1Action,
      () => navigateTo('hub'),
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

  // ─── «Вид» ──────────────────────────────────────────────────
  // Three clickable preview cards. Each one still wraps the SAME radio the
  // settings writer already reads, so picking a theme rides the existing
  // debounced save path — no second writer, no new storage field.
  const appearanceSection = createSection(
    COPY.appearance.title,
    COPY.appearance.subtitle,
  );
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
    previewBody.append(previewBar, previewBarShort);
    preview.append(previewRail, previewBody);
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
  appearanceSection.append(themeCards);

  // ─── «Генерация» (Stage 32: keys/models are kernel-side) ────
  const apiSection = createSection(COPY.generation.title, COPY.generation.subtitle);

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
  const countHints = new Map<HTMLInputElement, HTMLSpanElement>();
  const numberRow = (
    title: string,
    hintText: string,
    input: HTMLInputElement,
  ): HTMLElement => {
    const hint = document.createElement('span');
    hint.className = 'chatgoose-row-hint';
    hint.textContent = `${input.min}–${input.max}`;
    countHints.set(input, hint);
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
    control.className = 'chatgoose-row-control';
    control.append(hint, stepper);
    // A wheel over a focused number input silently changes the value while
    // the chatter is just scrolling the page — blur keeps the scroll a scroll.
    input.addEventListener('wheel', () => {
      if (document.activeElement === input) {
        input.blur();
      }
    }, { passive: true });
    return settingRow(title, hintText, control);
  };
  const flashClampHint = (input: HTMLInputElement, value: number): void => {
    const hint = countHints.get(input);
    if (!hint) {
      return;
    }
    hint.textContent = COPY.generation.savedAs.replace('{n}', String(value));
    hint.classList.add('chatgoose-row-hint-clamped');
    window.setTimeout(() => {
      hint.textContent = `${input.min}–${input.max}`;
      hint.classList.remove('chatgoose-row-hint-clamped');
    }, 2600);
  };

  /** A captioned subgroup of setting rows. Three of them carry the pane: what
   * goes into a prompt, what the coach does, and the service switch. */
  const settingGroup = (caption: string, rows: HTMLElement[]): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'chatgoose-group';
    group.dataset.settingGroup = caption;
    const cap = document.createElement('div');
    cap.className = 'chatgoose-group-cap';
    cap.textContent = caption;
    const list = document.createElement('div');
    list.className = 'chatgoose-rows';
    list.append(...rows);
    group.append(cap, list);
    return group;
  };

  apiSection.append(
    settingGroup(COPY.generation.groupWindows, [
      numberRow(COPY.generation.quickTitle, COPY.generation.quickHint, quickInput),
      numberRow(COPY.generation.pingTitle, COPY.generation.pingHint, pingInput),
      numberRow(COPY.generation.improveTitle, COPY.generation.improveHint, improveInput),
      numberRow(COPY.generation.deepTitle, COPY.generation.deepHint, deepInput),
    ]),
    settingGroup(COPY.generation.groupCoach, [
      numberRow(
        COPY.generation.coachHistoryTitle,
        COPY.generation.coachHistoryHint,
        coachHistoryInput,
      ),
      coachRecapRow,
    ]),
    settingGroup(COPY.generation.groupService, [
      settingRow(COPY.generation.debugTitle, COPY.generation.debugHint, debugSwitch, {
        asLabel: true,
      }),
    ]),
  );

  // ─── «Хоткеи» (read-only reference) ─────────────────────────
  // Derived from the live binding table, so the pane cannot drift from what the
  // keymap dispatches. The platform is detected at render time: the same install
  // shows ⌘⇧ on macOS and Alt+Shift elsewhere.
  const hotkeysSection = createSection(COPY.hotkeys.title, COPY.hotkeys.subtitle);
  const hotkeysHint = document.createElement('div');
  hotkeysHint.className = 'chatgoose-status-hint';
  hotkeysHint.textContent = COPY.hotkeys.hint;
  hotkeysSection.append(
    renderHotkeysPane(document, detectLabelPlatform()),
    hotkeysHint,
  );

  // ─── Agency Hub ───────────────────────────────────────────
  const agencyHubSection = createSection(COPY.hub.title, COPY.hub.subtitle);
  const agencyHubUrlInput = document.createElement('input');
  agencyHubUrlInput.type = 'url';
  agencyHubUrlInput.className = 'chatgoose-input';
  agencyHubUrlInput.placeholder = COPY.hub.baseUrlPlaceholder;
  agencyHubUrlInput.value = state.settings.agencyHubBaseUrl;

  const agencyHubKeyInput = document.createElement('input');
  agencyHubKeyInput.type = 'password';
  agencyHubKeyInput.autocomplete = 'off';
  agencyHubKeyInput.className = 'chatgoose-input';
  agencyHubKeyInput.value = state.settings.agencyHubApiKey;

  const agencyHubToggle = createButton(COPY.hub.legacyKeyShow, true);
  agencyHubToggle.addEventListener('click', () => {
    agencyHubKeyInput.type = agencyHubKeyInput.type === 'password' ? 'text' : 'password';
    agencyHubToggle.textContent = agencyHubKeyInput.type === 'password'
      ? COPY.hub.legacyKeyShow
      : COPY.hub.legacyKeyHide;
  });

  const agencyHubKeyRow = document.createElement('div');
  agencyHubKeyRow.style.display = 'grid';
  agencyHubKeyRow.style.gridTemplateColumns = '1fr auto';
  agencyHubKeyRow.style.gap = '8px';
  agencyHubKeyRow.append(agencyHubKeyInput, agencyHubToggle);

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

  const agencyHubPermissionButton = createButton(COPY.status.grantAccess, true);
  const agencyHubConnectionRow = hubStatusRow(COPY.hub.connLabel);
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
  agencyHubActionRow.append(agencyHubConnectionButton, agencyHubPermissionButton);

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
  /** True while THIS page owns a custody write — the sign-in / re-issue RPC or
   * «Выйти» — INCLUDING the permission → connection-test → hydrate chain that
   * path runs afterwards. The background's write reaches this document as a
   * `storage.onChanged` event too, and it can arrive before the RPC resolves: the
   * cross-tab fence must then still APPLY the new custody state (it is real) but
   * must NOT re-run that chain, or every hub check would fire twice. */
  let ownCustodyWriteInFlight = false;

  const renderAgencyHubConnectionState = (): void => {
    const normalizedBaseUrl = normalizeAgencyHubBaseUrl(agencyHubUrlInput.value);
    const hasInputs = hasAgencyHubConnectionInputs(agencyHubUrlInput.value, agencyHubKeyInput.value, state.settings.agencyHubDeviceToken);

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
          ? [
              formatClockTime(lastConnectionCheck.at),
              COPY.hub.checkDuration.replace('{n}', String(lastConnectionCheck.durationMs)),
              lastConnectionCheck.viaDeviceToken
                ? COPY.hub.checkViaDeviceToken
                : COPY.hub.checkViaLegacyKey,
            ].join(' · ')
          : (agencyHubConnectionFeedback.baseUrl || normalizedBaseUrl || '');
        agencyHubConnectionMeta.textContent = '';
        return;
      case 'failed': {
        const failedError = agencyHubConnectionFeedback.error;
        const description = getUserErrorDescription(failedError);
        setStatusPill(agencyHubConnectionStatus, 'bad', failedError.code);
        agencyHubConnectionMono.textContent = '';
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
    hubPermissionChecked = true;
    refreshStatusView();
    renderHubDiagnostics();

    if (permissionGranted) {
      agencyHubPermissionFeedback = null;
    }

    agencyHubPermissionButton.textContent = permissionGranted
      ? COPY.hub.reconnectAccess
      : COPY.status.grantAccess;
    agencyHubPermissionButton.disabled = !originPattern;

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

    if (!hasApiKey) {
      setPermissionState('warn', COPY.hub.permPillNeedsCredential, appendAgencyHubMeta(
        COPY.hub.permNoCredential.replace('{origin}', originPattern ?? ''),
        permissionScopeNote,
      ));
      return;
    }

    // Never claim readiness here: this is a local check (permission + a
    // non-empty credential) — only the live connection test below proves sync.
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
  const hubReissueButton = createButton(COPY.hub.reissueToken, true);
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
          hubSignInMeta.textContent = COPY.hub.signInIssued
            .replace('{prefix}', response.keyPrefix)
            .replace('{date}', new Date(response.expiresAt).toLocaleDateString());
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
  hubSignInWrap.className = 'chatgoose-card';
  hubReissueButton.style.justifySelf = 'start';
  const hubTokenActions = document.createElement('div');
  hubTokenActions.className = 'chatgoose-card-actions';
  hubTokenActions.append(hubReissueButton);
  const hubTokenFallbackNote = document.createElement('div');
  hubTokenFallbackNote.className = 'chatgoose-status-hint';
  hubTokenFallbackNote.textContent = COPY.hub.tokenFallbackNote;
  hubSignInWrap.append(
    hubTokenRow,
    hubSignInRow,
    hubSignInMeta,
    hubTokenFallbackNote,
    hubTokenActions,
  );

  // The connect-zone card is assembled in the pane layout below — the base-URL
  // field it opens with is created there.
  const agencyHubConnectCard = document.createElement('div');
  agencyHubConnectCard.className = 'chatgoose-card';

  // The device token is the main path (E9d) — the legacy key stays reachable
  // but folded, open only when one is actually stored.
  const legacyKeyDetails = document.createElement('details');
  legacyKeyDetails.className = 'chatgoose-details';
  legacyKeyDetails.open = Boolean(state.settings.agencyHubApiKey.trim());
  const legacyKeySummary = document.createElement('summary');
  legacyKeySummary.textContent = COPY.hub.legacyKeyFold;
  legacyKeyDetails.append(
    legacyKeySummary,
    labeledField(COPY.hub.legacyKeyFieldLabel, agencyHubKeyRow),
  );
  hubSignInWrap.append(legacyKeyDetails);

  // ── Danger zone: sign-out and its two-step confirm, fenced off at the bottom ──
  const hubDangerRow = document.createElement('div');
  hubDangerRow.className = 'chatgoose-hub-danger-row';
  hubDangerRow.append(hubSignOutButton, hubSignOutHint);
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
  hubConnectionCard.className = 'chatgoose-card';
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
    set: (view: { badge: string; tone: BadgeTone; fact: string; detail?: string }) => void;
  } => {
    const root = document.createElement('div');
    root.className = 'chatgoose-hub-drow';
    root.dataset.hubDetail = key;
    if (hydration === 'async') {
      root.dataset.deeplinkReady = 'false';
    }
    const badge = createBadge('…', 'neutral', true);
    const labelNode = document.createElement('span');
    labelNode.className = 'chatgoose-hub-drow-label';
    labelNode.textContent = label;
    const fact = document.createElement('span');
    fact.className = 'chatgoose-hub-drow-fact';
    const detail = document.createElement('div');
    detail.className = 'chatgoose-hub-drow-det';
    root.append(badge, labelNode, fact, detail);
    return {
      root,
      set: (view) => {
        badge.textContent = view.badge;
        badge.className = `chatgoose-badge chatgoose-badge-${view.tone} chatgoose-badge-mono`;
        fact.textContent = view.fact;
        detail.textContent = view.detail ?? '';
      },
    };
  };

  // «Проверка» is deliberately SYNC: its value is complete from in-page state on
  // the very first paint — either the last live test or the honest «проверка не
  // выполнялась» — so it is never a placeholder waiting on a read.
  const hubCheckRow = hubDiagRow(COPY.hub.checkLabel, 'check');
  const hubHostAccessRow = hubDiagRow(COPY.hub.hostAccessLabel, 'host-access', 'async');
  const hubContractRow = hubDiagRow(COPY.hub.contractLabel, 'contract', 'async');
  const hubErrorsRow = hubDiagRow(COPY.hub.errorsLabel, 'errors', 'async');
  const hubFanSummaryRow = hubDiagRow(COPY.hub.fanSummaryLabel, 'fan-summary', 'async');
  const hubDiagnosticsCard = document.createElement('div');
  hubDiagnosticsCard.className = 'chatgoose-hub-diag';
  hubDiagnosticsCard.dataset.hubDiagnostics = 'true';
  hubDiagnosticsCard.append(
    hubCheckRow.root,
    hubHostAccessRow.root,
    hubContractRow.root,
    hubErrorsRow.root,
    hubFanSummaryRow.root,
  );

  // Tagged so a `CG-HUB-01` (invalid URL) deep link can highlight the field the
  // code is actually about.
  const hubBaseUrlField = labeledField(COPY.hub.baseUrlLabel, agencyHubUrlInput);
  hubBaseUrlField.dataset.hubField = 'base-url';

  // Address, host access and the live test share one fate — one card.
  agencyHubConnectCard.append(
    hubBaseUrlField,
    agencyHubPermissionRow.root,
    agencyHubPermissionMeta,
    agencyHubConnectionRow.root,
    agencyHubConnectionMeta,
    agencyHubActionRow,
  );

  // ── Pane layout: four zones in the working order, danger fenced at the end ──
  const hubZone = (cap: string, ...children: HTMLElement[]): HTMLElement => {
    const zone = document.createElement('div');
    zone.className = 'chatgoose-group';
    const capNode = document.createElement('div');
    capNode.className = 'chatgoose-group-cap';
    capNode.textContent = cap;
    zone.append(capNode, ...children);
    return zone;
  };

  agencyHubSection.append(
    hubZone(COPY.hub.zoneConnection, agencyHubConnectCard),
    hubZone(COPY.hub.zoneSignIn, hubSignInWrap),
    hubZone(COPY.hub.zoneAccount, hubConnectionCard),
    hubZone(COPY.hub.zoneDiagnostics, hubDiagnosticsCard),
    hubDangerZone,
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

  // «Проверить всё» is THE action of this pane, so it alone wears the primary
  // clay; the honesty note lives in the report button's tooltip now that the
  // visible hint below is a single line.
  const checkAllButton = createButton(COPY.status.checkAll);
  const copyReportButton = createButton(COPY.status.copyReport, true);
  copyReportButton.title = COPY.status.reportHonesty;
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

  /** The checklist is live: every step reads the same sources the «Статус» rows
   * do, so a step turns green the moment its state is genuinely satisfied — and
   * only then. Step 1 demands a granted permission (not merely «not refused»):
   * on a fresh install nothing has been granted yet, and the readiness row's
   * lenient `!== false` would show step 1 as done before anything happened. */
  const onboardingStepStates = (): Record<OnboardingStepKey, boolean> => ({
    access: Boolean(normalizeAgencyHubBaseUrl(agencyHubUrlInput.value)) &&
      hubPermissionGranted === true,
    // A live identity read is the only proof a credential actually works —
    // truer than «a token string exists in storage».
    signIn: statusModel.identity?.ok === true,
    fansly: capturedAccountIds.length > 0 &&
      capturedAccountIds.every((accountId) => isAccountPersonaMapped(accountId)),
  });

  /** True once the durable flag AND the mount snapshot agree this install has
   * never been set up. Never re-enabled afterwards: a sign-out must not put a
   * working chatter back through onboarding. */
  let onboardingVisible = false;
  /** One-shot guard around the durable stamp; re-armed if the write fails. */
  let onboardingStamping = false;

  /** The checklist and the readiness hero are ONE decision: while the checklist
   * is up it owns the three open steps (with a CTA each), so the hero — which
   * would restate exactly that list one card below — is hidden. The hero returns
   * the moment onboarding is dismissed, or immediately on an install that was
   * never fresh. This function is the single writer of both flags. */
  const renderOnboarding = (): void => {
    if (!onboardingVisible) {
      onboardingSection.hidden = true;
      readinessHero.hidden = false;
      return;
    }
    const states = onboardingStepStates();
    for (const key of Object.keys(states) as OnboardingStepKey[]) {
      const step = onboardingSteps[key];
      const done = states[key];
      step.root.dataset.done = done ? 'true' : 'false';
      step.action.hidden = done;
      step.done.hidden = !done;
    }
    onboardingSection.hidden = false;
    readinessHero.hidden = true;
    if (!Object.values(states).every(Boolean) || onboardingStamping) {
      return;
    }
    // Every step is really done — stamp the durable flag and retire the card.
    // Filling in the hub URL is NOT this moment (the v1 self-cancel bug).
    onboardingStamping = true;
    void sendRuntimeRequest('dismissOnboarding')
      .then((reply) => {
        if (disposed) return;
        if (reply?.ok === true) {
          onboardingVisible = false;
          onboardingSection.hidden = true;
          // Setup is over: the headline takes the card's place immediately —
          // «Готово к смене.» is exactly what the chatter earned.
          readinessHero.hidden = false;
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
    // Both rows read ONE source: a non-null response is the settled answer
    // (`{ok:false}` included), `null` is «the identity read has not landed».
    markHubRowHydrated(hubIdentityRow, identity !== null);
    markHubRowHydrated(hubPagesRow, identity !== null);

    // Проверка — when, outcome, how long, and which credential carried it.
    if (!lastConnectionCheck) {
      hubCheckRow.set({ badge: '—', tone: 'neutral', fact: COPY.hub.checkNever });
    } else {
      const via = lastConnectionCheck.viaDeviceToken
        ? COPY.hub.checkViaDeviceToken
        : COPY.hub.checkViaLegacyKey;
      hubCheckRow.set({
        badge: lastConnectionCheck.ok ? 'OK' : 'FAIL',
        tone: lastConnectionCheck.ok ? 'green' : 'bad',
        fact: lastConnectionCheck.ok
          ? `${COPY.hub.checkSuccess} · ${via}`
          : `${COPY.hub.checkFailure}${lastConnectionCheck.code ? ` ${lastConnectionCheck.code}` : ''} · ${via}`,
        detail: [
          formatClockTime(lastConnectionCheck.at),
          COPY.hub.checkDuration.replace('{n}', String(lastConnectionCheck.durationMs)),
        ].join(' · '),
      });
    }

    // Доступ к хосту
    const originPattern = buildAgencyHubOriginPattern(
      normalizeAgencyHubBaseUrl(agencyHubUrlInput.value),
    );
    if (hubPermissionGranted === null || !originPattern) {
      hubHostAccessRow.set({ badge: '—', tone: 'neutral', fact: COPY.common.unknown });
    } else if (hubPermissionGranted) {
      hubHostAccessRow.set({
        badge: 'OK',
        tone: 'green',
        fact: COPY.hub.hostAccessGranted,
        detail: originPattern,
      });
    } else {
      hubHostAccessRow.set({ badge: 'НЕТ', tone: 'amber', fact: COPY.status.hubNoPermission });
    }
    // Settled once Firefox has answered `permissions.contains` — including the
    // «no origin to check» case, where «неизвестно» IS the final answer for the
    // address currently in the field.
    markHubRowHydrated(hubHostAccessRow, hubPermissionChecked);

    // Контракт SDK — ALWAYS visible here (the Статус row stays debug-only), and
    // it wears the same MATCH/DRIFT badge as the «Статус» pane's row.
    const health = statusModel.health;
    if (health?.ok) {
      const match = health.contractHash === health.sdkContractHash;
      hubContractRow.set({
        badge: match ? 'MATCH' : 'DRIFT',
        tone: match ? 'green' : 'bad',
        fact: match ? COPY.hub.contractMatches : COPY.hub.contractMismatch,
        detail: [
          health.contractHash.slice(0, 12),
          ...(health.sdkSourceCommit
            ? [COPY.status.contractSourceCommit.replace('{commit}', health.sdkSourceCommit.slice(0, 12))]
            : []),
        ].join(' · '),
      });
    } else {
      hubContractRow.set({ badge: '—', tone: 'neutral', fact: COPY.status.contractUnknown });
    }
    markHubRowHydrated(hubContractRow, health !== null);

    // Ошибки Hub — today's exact count in the badge; the list is capped at 20,
    // so say so rather than let «за сегодня: 37» look like 37 listed rows.
    const ops = statusModel.opsDaily;
    if (!ops) {
      hubErrorsRow.set({ badge: '—', tone: 'neutral', fact: COPY.common.unknown });
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
        badge: String(ops.hubErrorsTotal),
        tone: ops.hubErrorsTotal > 0 ? 'amber' : 'green',
        fact: COPY.hub.errorsToday.replace('{n}', String(ops.hubErrorsTotal)),
        ...(detail ? { detail } : {}),
      });
    }

    // Fan Summary — the last push that LANDED, honest-empty otherwise.
    const push = ops?.lastSummaryPush ?? null;
    if (!ops) {
      hubFanSummaryRow.set({ badge: '—', tone: 'neutral', fact: COPY.common.unknown });
    } else if (push) {
      hubFanSummaryRow.set({
        badge: 'OK',
        tone: 'green',
        fact: COPY.hub.fanSummaryLast
          .replace('{when}', formatClockTime(push.at))
          .replace('{account}', push.accountLabel || COPY.common.unknown),
      });
    } else {
      hubFanSummaryRow.set({ badge: '—', tone: 'neutral', fact: COPY.hub.fanSummaryEmpty });
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
      // The zero above is a placeholder, not an observation — carry the failure
      // into the model so «Скопировать отчёт» cannot turn it into a claim.
      statusModel.unavailable.fansly = true;
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
    // A successful re-poll clears an earlier failure: this snapshot IS an
    // observation, so the report may speak about it again.
    statusModel.unavailable.fansly = false;

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
        updateCoachRecapSegment();
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
  // The segment repaints from the same event — the hidden select stays the one
  // source of truth for every writer (buttons, tests, cross-tab merge).
  coachRecapSelect.addEventListener('change', updateCoachRecapWarning);
  coachRecapSelect.addEventListener('change', updateCoachRecapSegment);
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

  // ─── «Персоны» (server-owned catalog, metadata only) ────────
  const personalitiesSection = createSection(
    COPY.personas.title,
    COPY.personas.subtitle,
  );
  const personalitiesList = document.createElement('div');
  personalitiesList.className = 'chatgoose-persona-rows';
  let refreshAccountMappingPersonalityOptions: (() => void) | null = null;

  // Catalog footer: when it last CHANGED, plus the only refresh path there is.
  const personaCatalogLine = document.createElement('div');
  personaCatalogLine.dataset.role = 'persona-catalog';
  personaCatalogLine.className = 'chatgoose-persona-catalog';
  // There is no standalone «refetch the catalog» operation, and inventing one is
  // out of scope: the background re-reads the catalog after a SUCCESSFUL
  // connection test, so the button says exactly what it does.
  const personaRefreshButton = createButton(COPY.personas.catalogRefresh, true);
  personaRefreshButton.dataset.role = 'persona-catalog-refresh';
  personaRefreshButton.addEventListener('click', () => {
    personaRefreshButton.disabled = true;
    void (async () => {
      try {
        await refreshAgencyHubPermissionState();
        if (!disposed) {
          await runAgencyHubConnectionTest({ force: true, saveFirst: true });
        }
      } finally {
        if (!disposed) personaRefreshButton.disabled = false;
      }
    })();
  });
  const personaRefreshHint = document.createElement('div');
  personaRefreshHint.className = 'chatgoose-status-hint';
  personaRefreshHint.textContent = COPY.personas.catalogRefreshHint;
  const personaFooter = document.createElement('div');
  personaFooter.className = 'chatgoose-persona-footer';
  personaFooter.append(personaCatalogLine, personaRefreshButton);

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
    personaCatalogLine.textContent = `${COPY.personas.catalogLabel}: ${
      changedDate
        ? COPY.personas.catalogUpdated.replace('{date}', changedDate)
        : COPY.personas.catalogNever
    }`;
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
      const count = document.createElement('span');
      count.className = 'chatgoose-persona-count';
      count.textContent = COPY.personas.accountsCount.replace(
        '{n}',
        String(view.accountCount),
      );
      head.append(count);
      if (view.archived) {
        // Only reachable while a mapping still points at it — amber, because the
        // one useful instruction is «pick a replacement».
        head.append(createBadge(COPY.personas.archivedMapped, 'amber'));
      }
      row.append(head);
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
    personaFooter,
    personaRefreshHint,
    preservationFold,
  );

  // ─── «Аккаунты» ────────────────────────────────────────────
  const mappingsSection = createSection(COPY.accounts.title);
  mappingsSection.dataset.sessionHydration = 'loading';
  // Own node rather than createSection's description: the subtitle counts live
  // accounts, so it has to be repaintable.
  const accountsSubtitle = document.createElement('div');
  accountsSubtitle.className = 'chatgoose-section-desc';
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
  mappingsSection.append(accountsSubtitle, mappingsTable, accountsHint);
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
    clearFlash();
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
  ): void => {
    // Only a LIVE row wears a pill — a sleeping account is a quiet fact (grey
    // dot + the mono «была…»/«сессий не было» line), and a «не активна» plaque
    // on every quiet row shouted as loudly as the one live signal.
    info.replaceChildren(
      ...(connected
        ? [createStatusPill('ok', COPY.accounts.stateLive)]
        : []),
    );
    if (view && !view.usable) {
      // An archived persona still mapped: the only useful instruction is «pick a
      // replacement», which is exactly what the Персоны pane says too.
      info.append(createStatusPill('warn', COPY.personas.archivedMapped));
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
    /**
     * A CUSTODY key changed on disk and this document did not write it.
     *
     * The single-options-tab guarantee covers only the paths `openOptions` owns —
     * a manually opened second settings tab is real. Without this fence that tab
     * keeps the wiped token in `state.settings` after the other tab's «Выйти»:
     * it still renders «Device token active ✓», still offers «Выйти», and a
     * connection test from it would send a credential that no longer exists on
     * disk. So the fresh custody values are applied here and the hub state is
     * repainted from them (signed-out, after an external wipe).
     *
     * A local unsaved edit wins over the input FIELD only: `agencyHubApiKeyDirty`
     * means the chatter typed a key in THIS tab and has not saved it yet, so the
     * typed text stays — but `state.settings` and every signed-in indicator still
     * describe what is actually stored. E19 holds throughout: a wipe arrives as
     * EMPTY strings, never as removed keys.
     */
    const applyExternalCustodyChange = (persisted: Settings): void => {
      if (
        persisted.agencyHubDeviceToken === state.settings.agencyHubDeviceToken &&
        persisted.agencyHubApiKey === state.settings.agencyHubApiKey
      ) {
        // Already in sync — this tab's own write echoed back, or an unrelated
        // (settings / persona-catalog) event. Nothing to apply, and no reason to
        // re-run the hub checks the writing path already fired. This equality
        // check is the ONLY no-op suppressor, which is why the caller may invoke
        // this on every applied read instead of trusting a per-event flag.
        return;
      }
      const tokenChanged = persisted.agencyHubDeviceToken !== state.settings.agencyHubDeviceToken;
      const hadCredential = Boolean(
        state.settings.agencyHubDeviceToken.trim() || state.settings.agencyHubApiKey.trim(),
      );
      const wipedExternally = hadCredential &&
        !persisted.agencyHubDeviceToken.trim() &&
        !persisted.agencyHubApiKey.trim();
      state.settings = {
        ...state.settings,
        agencyHubDeviceToken: persisted.agencyHubDeviceToken,
        agencyHubApiKey: persisted.agencyHubApiKey,
      };
      if (!agencyHubApiKeyDirty && document.activeElement !== agencyHubKeyInput) {
        agencyHubKeyInput.value = persisted.agencyHubApiKey;
      }
      if (wipedExternally) {
        // Another tab (or the background) destroyed the credentials. THIS tab's
        // pending credential write must not resurrect them: the wave-B quiesce
        // only covers the tab that pressed «Выйти», so a debounced snapshot armed
        // here — 350 ms is easily inside the revoke window — would persist the
        // typed key AFTER the wipe, exactly the hole the sign-out quiesce closes
        // locally. Cancel that pending write, drop the credential's dirty claim,
        // and stale-out any ALREADY RUNNING one (the snapshot-version bump is the
        // same instrument the future-schema barrier uses, so an in-flight persist
        // can no longer move `state.settings.agencyHubApiKey` back). The typed
        // text stays in the field as a non-persisting draft; an explicit later
        // edit re-arms it deliberately.
        saveSettingsDebounced.cancel();
        agencyHubApiKeyDirty = false;
        settingsSnapshotVersion += 1;
        agencyHubApiKeySnapshotVersion = settingsSnapshotVersion;
        // The cancelled snapshot is deliberately NOT re-armed for its
        // non-credential half: `persist` writes the STORED key back into the field
        // whenever the dirty claim is gone, which would erase the draft this fence
        // just promised to keep. `settingsDirty` stays set, so the next edit, blur
        // or pagehide still persists those edits — without the credential, because
        // `collectSettingsPatch` only includes it for a dirty claim.
      }
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
   * degraded rows deliberately claim LESS — no 'seen' state, no observed page,
   * no tab id — instead of guessing.
   */
  const buildAccountRowViews = (
    sessions: SessionSnapshotEntry[],
  ): AccountsViewEntry[] => {
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
        state: session?.connected ? 'live' : 'never',
        lastSeenAt: session?.lastSeenAt ?? null,
        tabId: null,
        personaMapped: isAccountPersonaMapped(accountId),
        observedPage: null,
      } satisfies AccountsViewEntry;
    });
  };

  const renderAccountMappings = (
    sessions: SessionSnapshotEntry[],
    hydrationFailed: boolean,
  ): void => {
    const personalityViews = buildPersonalityMappingViews();
    const rows = buildAccountRowViews(sessions);

    mappingsTable.replaceChildren();
    mappingsSection.dataset.sessionHydration = hydrationFailed ? 'failed' : 'ready';
    // The loading line is gone: whatever this paint produced — rows, the fresh
    // empty state, or the refresh-failed warning — is the real answer, so a
    // pending deep-link highlight may now land on it.
    mappingsTable.dataset.deeplinkReady = 'true';

    accountsSubtitle.textContent = rows.length === 0
      ? COPY.accounts.subtitleFresh
      : COPY.accounts.subtitle
          .replace('{live}', String(rows.filter((row) => row.state === 'live').length))
          .replace('{total}', String(rows.length));

    if (hydrationFailed) {
      const warning = document.createElement('div');
      warning.textContent = COPY.accounts.refreshFailed;
      warning.style.color = 'var(--chatgoose-ink-mid)';
      mappingsTable.append(warning);
    }

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
      const labelNode = document.createElement('span');
      labelNode.className = 'chatgoose-account-label';
      labelNode.textContent = view.label;
      if (view.localLabel) {
        // Say WHOSE name this is — a local label must never be mistaken for the
        // model's real Fansly handle.
        labelNode.title = COPY.accounts.renameLocalTitle;
        labelNode.dataset.accountLocalLabel = 'true';
      } else if (view.label === shortenAccountId(accountId)) {
        // No name resolved and no label: the heading IS the id, so render it as
        // data rather than as a name.
        labelNode.classList.add('chatgoose-mono');
      }
      head.append(labelNode);

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'chatgoose-account-rename';
      renameButton.dataset.accountRename = accountId;
      renameButton.title = COPY.accounts.renameTitle;
      renameButton.setAttribute('aria-label', COPY.accounts.renameTitle);
      renameButton.textContent = '✎';
      head.append(renameButton);

      // Inline label editor: Enter saves through the runtime operation (the only
      // writer of the labels key), Esc — and a blur — cancel. There is no second
      // save path, so a half-typed label can never be persisted by accident.
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'chatgoose-input chatgoose-account-rename-input';
      labelInput.dataset.accountLabelInput = accountId;
      labelInput.placeholder = COPY.accounts.renameEmpty;
      labelInput.maxLength = 60;
      labelInput.value = view.localLabel ?? '';
      labelInput.hidden = true;

      const closeEditor = (): void => {
        labelInput.hidden = true;
        labelInput.value = view.localLabel ?? '';
        renameButton.hidden = false;
        labelNode.hidden = false;
      };
      renameButton.addEventListener('click', () => {
        labelNode.hidden = true;
        renameButton.hidden = true;
        labelInput.hidden = false;
        labelInput.focus();
        labelInput.select();
      });
      labelInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeEditor();
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
            }
          } catch (error) {
            // Keep the editor open with the typed text: a rename that did not
            // stick must not look like it did.
            console.error('Failed to save the local account label', error);
            if (!disposed) {
              labelInput.disabled = false;
              labelInput.focus();
            }
          }
        })();
      });
      labelInput.addEventListener('blur', () => {
        if (!labelInput.disabled) closeEditor();
      });
      head.append(labelInput);

      const sub = document.createElement('div');
      sub.className = 'chatgoose-account-sub';
      sub.append(createCopyableId(accountId));
      const subSep = document.createElement('span');
      subSep.className = 'chatgoose-account-sub-sep';
      subSep.setAttribute('aria-hidden', 'true');
      subSep.textContent = '·';
      sub.append(subSep);
      const facts: string[] = [
        isLive
          ? COPY.accounts.subTabActive
          : view.lastSeenAt !== null
            ? COPY.accounts.subSeenAt.replace('{when}', formatSeenWhen(view.lastSeenAt))
            : COPY.accounts.subNeverSeen,
      ];
      if (view.observedPage) {
        facts.push(COPY.accounts.corePage.replace('{page}', view.observedPage));
      }
      const factsNode = document.createElement('span');
      factsNode.className = 'chatgoose-account-facts';
      factsNode.dataset.role = 'account-facts';
      factsNode.textContent = facts.join(' · ');
      sub.append(factsNode);

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
      renderMappingInfo(info, mappedView, isLive);
      if (!view.personaMapped) {
        // Amber, not red: nothing is broken — the account simply cannot generate
        // until a persona is chosen, and the hint says exactly that.
        const aiOff = createBadge(COPY.accounts.personaUnmapped, 'amber');
        aiOff.dataset.accountAiOff = accountId;
        aiOff.title = COPY.accounts.personaUnmappedHint;
        info.append(aiOff);
      }
      actions.append(info);
      // «к вкладке» ONLY for a live row: the tab id comes from the worker's
      // in-memory capture map, and after a restart there is nothing to focus.
      if (isLive && view.tabId !== null) {
        const focusTab = createButton(COPY.accounts.focusTab, true);
        focusTab.dataset.accountFocusTab = accountId;
        focusTab.addEventListener('click', () => {
          void sendRuntimeRequest('focusAccountTab', { accountId })
            .catch((error: unknown) => {
              console.error('Failed to focus the Fansly tab', error);
            });
        });
        actions.append(focusTab);
      }

      row.append(dot, head, actions, sub, select);
      mappingsTable.append(row);
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

injectStyles(optionsStyles);
void render();
