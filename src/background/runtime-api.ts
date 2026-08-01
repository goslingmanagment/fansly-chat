import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  LAST_SEEN_VERSION_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  SPENDERS_BUILD_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_REASON,
  SPENDERS_RESOLVE_TIMEOUT_MS,
  VOICE_CAPABILITY_BUDGET_MS,
} from '../shared/constants.js';
import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { createUserError, toUserError } from '../shared/errors.js';
import {
  getRuntimeRequestType,
  isAgencyHubConnectionTestSettings,
  isObjectRecord,
} from '../shared/protocol.js';
import { getAvailableFanSummaryModes } from '../shared/summary-cache.js';
import { logWarn } from '../shared/log.js';
import { findActivePersona, getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { readStorageState, saveSettings } from '../shared/storage.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { formatOptionsHash, type PaneKey } from '../shared/options-routes.js';
import { ChatGooseError } from '../shared/errors.js';
import { issueAgencyHubDeviceToken } from './device-token.js';
import type {
  AccountsView,
  AccountsViewEntry,
  AgencyHubDeviceTokenMeta,
  AgencyHubSignOutResponse,
  LastSeenVersionSnapshot,
  OnboardingSnapshot,
  PopupStatus,
  RecapStatusResponse,
  SpendersBuildPayload,
} from '../shared/types.js';
import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreSnapshot,
} from '../shared/voice-attempt.js';
import { resolveHubBearer, type AgencyHubClient } from './agency-hub-client.js';
import type { DebugPromptStore } from './debug-prompt-store.js';
import type { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { getAccountLabels, setAccountLabel } from './account-labels.js';
import { getAccountPresence } from './account-presence.js';
import { getOpsDaily } from './ops-daily.js';
import { getLatestQuotaSnapshot, getQuotaSnapshotsByPage } from './quota-tracker.js';
import { getLatestSpendersObservation } from './spenders-status-tracker.js';
import type { SessionStore } from './session-store.js';
import type { SpendersService } from './spenders-service.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';
import type { VoiceService } from './voice-service.js';
import {
  VoiceAttemptRevisionConflictError,
  type VoiceAttemptRepository,
} from './voice-attempt-store.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

// Serialize every device-token custody mutation — sign-in / re-issue (issue +
// store) and sign-out (capture + wipe + revoke) — through ONE FIFO promise
// queue. Without it, a sign-in landing mid-sign-out could interleave so a
// freshly issued token is stored locally, then the sign-out's wipe erases it
// while its revoke kills a DIFFERENT (captured) token — leaving a live,
// un-revocable token orphaned on the hub. Under the lock each critical section
// (which captures the token to revoke only INSIDE the section, right before the
// wipe) runs to completion before the next begins, so the two never observe
// each other's half-written state. Re-issue rides the same `issue` path, so it
// is covered by the same lock.
let agencyHubCustodyQueue: Promise<unknown> = Promise.resolve();
function withAgencyHubCustodyLock<T>(critical: () => Promise<T>): Promise<T> {
  // Chain onto the tail regardless of how the previous holder settled, so one
  // rejection never poisons the queue for the next waiter.
  const run = agencyHubCustodyQueue.then(critical, critical);
  agencyHubCustodyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Drop the metadata record describing a token that no longer exists here.
 *
 * The metadata is CUSTODY-RELEVANT, not a display convenience: `issuedFrom`
 * decides which hub the sign-out revoke is aimed at. That is why the ISSUE path
 * commits the token and this record in ONE `storage.set` (see
 * `issueAgencyHubDeviceToken` below) instead of writing them separately.
 *
 * The REMOVAL, however, may stay best-effort: it runs only after the custody
 * keys were already wiped to empty strings, and a leftover record cannot
 * resurrect a token — the next sign-out finds no bearer to revoke, and the next
 * issuance overwrites the record atomically with its own address. Its own
 * storage.local key with its own `version`, never the settings blob (schema
 * stays v15) and never a custody key. Called inside the auth critical section,
 * so it is already serialized against every other token mutation. */
async function clearDeviceTokenMeta(): Promise<void> {
  try {
    await browser.storage.local.remove(AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY);
  } catch (error) {
    logWarn('Device token metadata removal failed', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
  }
}

async function readDeviceTokenMeta(): Promise<AgencyHubDeviceTokenMeta | null> {
  try {
    const raw = await browser.storage.local.get(AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY);
    const value = raw[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY];
    if (
      !isObjectRecord(value) ||
      value.version !== 1 ||
      typeof value.keyPrefix !== 'string' ||
      typeof value.issuedAt !== 'number' ||
      typeof value.expiresAt !== 'string'
    ) {
      // Absent or foreign-version: honest null, never a half-trusted record.
      return null;
    }
    return {
      version: 1,
      keyPrefix: value.keyPrefix,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      // Optional: records written before the issuing-hub fix have no address.
      // A non-string is dropped rather than trusted — sign-out then falls back
      // to the current base URL instead of revoking against garbage.
      ...(typeof value.issuedFrom === 'string' && value.issuedFrom
        ? { issuedFrom: value.issuedFrom }
        : {}),
    };
  } catch {
    return null;
  }
}

// Operational-key writes (the onboarding flag, the last-seen version) rewrite a
// whole record, so they run through ONE module-level FIFO queue — the same
// doctrine the presence/labels stores follow. Two settings tabs finishing the
// checklist at the same moment therefore cannot lose one another's stamp.
let operationalWriteQueue: Promise<unknown> = Promise.resolve();
function withOperationalWrite<T>(critical: () => Promise<T>): Promise<T> {
  const run = operationalWriteQueue.then(critical, critical);
  operationalWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// The single-options-tab guarantee is a read-then-create sequence, so it needs
// its OWN FIFO: two requests arriving in the same tick (a double-clicked
// «Settings» on the mapping banner is one click too many, and that button is not
// one-shot) would both see «no tab» at the `tabs.query` await and both create
// one — two options tabs, i.e. two pagehide settings writers over one blob.
// Separate from the operational-write queue on purpose: a slow storage stamp
// must not delay opening the page, and vice versa.
let openOptionsQueue: Promise<unknown> = Promise.resolve();
function withOpenOptionsLock<T>(critical: () => Promise<T>): Promise<T> {
  const run = openOptionsQueue.then(critical, critical);
  openOptionsQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** First-run checklist flag. An absent or foreign-version record reads as «not
 * dismissed yet» — the honest default for a browser profile that has never run
 * this version. */
async function readOnboardingState(): Promise<OnboardingSnapshot> {
  const fresh: OnboardingSnapshot = { version: 1, dismissedAt: null };
  try {
    const raw = await browser.storage.local.get(ONBOARDING_STORAGE_KEY);
    const value = raw[ONBOARDING_STORAGE_KEY];
    if (!isObjectRecord(value) || value.version !== 1) {
      return fresh;
    }
    return {
      version: 1,
      dismissedAt: typeof value.dismissedAt === 'number' && Number.isFinite(value.dismissedAt)
        ? value.dismissedAt
        : null,
    };
  } catch {
    return fresh;
  }
}

/** Which release's changelog has already been opened. An unreadable record is
 * «none seen», which shows the «нов.» dot — nagging once is strictly better than
 * silently hiding a release note. */
async function readLastSeenVersion(): Promise<LastSeenVersionSnapshot> {
  const unseen: LastSeenVersionSnapshot = { version: 1, lastSeenVersion: null };
  try {
    const raw = await browser.storage.local.get(LAST_SEEN_VERSION_STORAGE_KEY);
    const value = raw[LAST_SEEN_VERSION_STORAGE_KEY];
    if (!isObjectRecord(value) || value.version !== 1) {
      return unseen;
    }
    return {
      version: 1,
      lastSeenVersion: typeof value.lastSeenVersion === 'string' && value.lastSeenVersion
        ? value.lastSeenVersion
        : null,
    };
  } catch {
    return unseen;
  }
}

export interface RuntimeApiDeps {
  agencyHubClient: AgencyHubClient;
  fanslyClient: FanslyClient;
  sessionStore: SessionStore;
  spendersService: SpendersService;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
  debugPrompts: DebugPromptStore;
  /** Pushes board-build progress/snapshots to the requesting tab's content port. */
  emitToTab?: (tabId: number, message: SpendersBuildPayload) => void;
  /** A successful live test is a reliable signal to refresh the persona catalog. */
  onAgencyHubReady?: () => void | Promise<void>;
  /** Fail-closed page capability resolver shared with tab:init state. The
   * popup takes the budgeted variant: a cold probe must not hold first paint. */
  voiceService?: Pick<VoiceService, 'resolveCapabilityFast'>;
  /** Background-owned session repository for acknowledged voice custody. */
  voiceAttempts: Pick<VoiceAttemptRepository, 'load' | 'save' | 'remove'>;
}

/** E28. The prompt echo is readable by ONE caller: our own viewer page. The
 * content script running inside fansly.com must not be able to ask for it — it
 * shares a document with the site's JS, and a compromised page could otherwise
 * walk the runtime API to the persona and the dossier. Compare the sender's
 * origin AND path (not a prefix — `debug-prompt.html.evil` starts with it too);
 * the query string is where the token rides, so it is excluded from the match. */
export const DEBUG_PROMPT_PAGE_PATH = 'debug-prompt.html';

/** `options_ui.page` in the manifest — the deep-link target. Exported so a test
 * can pin it to the manifest: if the two drift, `tabs.query` silently stops
 * finding the open settings tab and the singleton degrades to always-create
 * (i.e. a second pagehide settings writer per deep link). */
export const OPTIONS_PAGE_PATH = 'options.html';

function isDebugPromptViewer(sender: browser.runtime.MessageSender): boolean {
  if (typeof sender.url !== 'string') {
    return false;
  }
  try {
    const senderUrl = new URL(sender.url);
    const viewerUrl = new URL(browser.runtime.getURL(DEBUG_PROMPT_PAGE_PATH));
    return senderUrl.origin === viewerUrl.origin && senderUrl.pathname === viewerUrl.pathname;
  } catch {
    return false;
  }
}

/** Options' formatAccountHeading ladder minus its id fallback — the popup
 * renders ids itself when no human name has resolved yet. */
function formatSessionAccountName(
  session: { resolvedUsername: string | null; resolvedDisplayName: string | null } | null,
): string | null {
  const displayName = session?.resolvedDisplayName?.trim() || null;
  const username = session?.resolvedUsername?.trim().replace(/^@+/, '') || null;
  if (displayName && username && displayName.replace(/^@+/, '') !== username) {
    return `${displayName} (@${username})`;
  }
  if (username) {
    return `@${username}`;
  }
  return displayName;
}

/** Same shortening as Options' `shortenAccountId`: an 18-digit Fansly id does
 * not read as a row heading, but enough of it must survive to tell two accounts
 * apart. The full id stays in the pane's «ID аккаунта» line. */
function shortenAccountId(accountId: string): string {
  return accountId.length > 12
    ? `${accountId.slice(0, 4)}…${accountId.slice(-4)}`
    : accountId;
}

/** What an «Аккаунты» row leads with. The chatter's own label wins over the
 * model's public name — she named it for a reason (six accounts, one face). */
function buildAccountRowLabel(
  accountId: string,
  localLabel: string | null,
  username: string | null,
  displayName: string | null,
): string {
  return (
    localLabel ??
    formatSessionAccountName({ resolvedUsername: username, resolvedDisplayName: displayName }) ??
    shortenAccountId(accountId)
  );
}

/** Every fansly.com tab, however deep the route. Matches the manifest's own
 * host permission so the query can never ask for more than is granted. */
const FANSLY_TAB_URL_PATTERN = '*://fansly.com/*';

interface ValidVoiceAttemptSender {
  tabId: number;
  groupId: string;
}

function voiceAttemptSender(
  sender: browser.runtime.MessageSender | undefined,
  route: StoredVoiceAttemptRoute,
  sessionStore: SessionStore,
  tabContexts: TabContextStore,
): ValidVoiceAttemptSender | null {
  const tabId = sender?.tab?.id;
  // tab.url FIRST: Firefox freezes sender.url at the document's LOAD URL and
  // never updates it across history.pushState, while tab.url tracks the live
  // SPA route (verified empirically, Firefox 152). Fansly opens conversations
  // via pushState, so validating against sender.url rejected every SPA-opened
  // conversation as invalid_sender.
  const rawUrl = sender?.tab?.url ?? sender?.url;
  if (typeof tabId !== 'number' || typeof rawUrl !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'fansly.com') {
    return null;
  }
  const groupId = parseGroupIdFromUrl(url.href);
  if (!groupId || groupId !== route.groupId) {
    return null;
  }

  const context = tabContexts.get(tabId);
  if (context?.groupId !== null && context?.groupId !== undefined && context.groupId !== groupId) {
    return null;
  }
  // The session's alias set is authoritative for the account check: the tab
  // context's accountId oscillates between the legacy captured id and the
  // canonical resolved id (handleCapture rewrites it on every Fansly request),
  // so an exact context match produced false invalid_sender rejections while
  // tab traffic was flowing. The context id is consulted only when no session
  // is known for this tab.
  const session = sessionStore.getSessionForTab(tabId);
  const reliableAccounts = new Set(
    [session?.accountId, session?.resolvedAccountId]
      .filter((accountId): accountId is string => Boolean(accountId)),
  );
  if (reliableAccounts.size > 0) {
    if (!reliableAccounts.has(route.accountId)) {
      return null;
    }
  } else if (context?.accountId && context.accountId !== route.accountId) {
    return null;
  }
  return { tabId, groupId };
}

export function registerRuntimeApi({
  agencyHubClient,
  fanslyClient,
  sessionStore,
  spendersService,
  tabContexts,
  storageCoordinator,
  debugPrompts,
  emitToTab,
  onAgencyHubReady,
  voiceService,
  voiceAttempts,
}: RuntimeApiDeps): void {
  browser.runtime.onMessage.addListener(
    async (message: unknown, sender: browser.runtime.MessageSender) => {
      const requestType = getRuntimeRequestType(message);
      if (!requestType) {
        return undefined;
      }

      if (requestType === 'voiceAttemptLoad') {
        const { route } = message as { route: StoredVoiceAttemptRoute };
        if (!voiceAttemptSender(sender, route, sessionStore, tabContexts)) {
          return { version: 2, ok: false, error: 'invalid_sender' } as const;
        }
        const entries = await voiceAttempts.load(route);
        return { version: 2, ok: true, entries } as const;
      }

      if (requestType === 'voiceAttemptSave') {
        const { snapshot, expectedRevision } = message as {
          snapshot: VoiceAttemptStoreSnapshot;
          expectedRevision: number;
        };
        if (
          !voiceAttemptSender(
            sender,
            snapshot.attempt.boundRoute,
            sessionStore,
            tabContexts,
          )
        ) {
          return { version: 2, ok: false, error: 'invalid_sender' } as const;
        }
        try {
          const revision = await voiceAttempts.save(snapshot, expectedRevision);
          return { version: 2, ok: true, revision } as const;
        } catch (error) {
          if (error instanceof VoiceAttemptRevisionConflictError) {
            return { version: 2, ok: false, error: 'revision_conflict' } as const;
          }
          throw error;
        }
      }

      if (requestType === 'voiceAttemptRemove') {
        const { attemptId, route, expectedRevision } = message as {
          attemptId: string;
          route: StoredVoiceAttemptRoute;
          expectedRevision: number;
        };
        if (!voiceAttemptSender(sender, route, sessionStore, tabContexts)) {
          return { version: 2, ok: false, error: 'invalid_sender' } as const;
        }
        try {
          await voiceAttempts.remove(attemptId, route, expectedRevision);
          return { version: 2, ok: true } as const;
        } catch (error) {
          if (error instanceof VoiceAttemptRevisionConflictError) {
            return { version: 2, ok: false, error: 'revision_conflict' } as const;
          }
          throw error;
        }
      }

      if (requestType === 'ensureStorageReady') {
        await storageCoordinator.ensurePersistedState();
        return { ready: true } as const;
      }

      if (requestType === 'getPopupStatus') {
        let tabId: number | undefined;
        let tabUrl: string | undefined;
        const requestedTabId = isObjectRecord(message) && typeof message.tabId === 'number'
          ? message.tabId
          : undefined;

        if (requestedTabId !== undefined) {
          const tab = await browser.tabs.get(requestedTabId);
          tabId = tab.id ?? requestedTabId;
          tabUrl = tab.url;
        } else {
          const [activeTab] = await browser.tabs.query({
            active: true,
            currentWindow: true,
          });
          tabId = activeTab?.id;
          tabUrl = activeTab?.url;
        }

        if (!tabId) {
          return {
            tabId: -1,
            accountId: null,
            groupId: null,
            hasAvailableSummary: false,
            availableRecaps: { full: false, short: false },
            connected: false,
            hasApiKey: false,
            voiceNotesCapable: false,
            hasPersonalities: false,
            mappedPersonalityId: null,
            mappedPersonalityName: null,
            mappedPersonaVersion: null,
            mappedPersonaDefinitionId: null,
            mappedPersonaSource: null,
            compareCardCount: 0,
            compareDraftCount: 0,
            accountLabel: 'Не подключено',
            accountName: null,
            fanName: null,
            aiQuota: null,
          } satisfies PopupStatus;
        }

        const state = await storageCoordinator.getState();
        const session = sessionStore.getSessionForTab(tabId);
        const legacyAccountId = sessionStore.getAccountIdForTab(tabId);
        const accountId = session?.resolvedAccountId ?? legacyAccountId;
        const context = tabContexts.getOrCreate(tabId);
        // Popup reads must not clobber the content script's authoritative route.
        // Prefer the tracked groupId (kept fresh by tab:routeChanged) and fall
        // back to the tab URL only when none has been recorded yet.
        const displayGroupId = context.groupId ?? parseGroupIdFromUrl(tabUrl);
        context.accountId = accountId;

        const rawMappedPersonalityId = resolveMappedPersonalityId(
          state.accountMappings,
          accountId,
          legacyAccountId,
          state.accountAliases,
        );
        const mappedPersonality = findActivePersona(
          state.personaCatalog,
          rawMappedPersonalityId,
        );
        const mappedPersonalityId = mappedPersonality?.key ?? null;
        const mappedPersonalityName = mappedPersonality?.displayName ?? null;
        const mappedPersonaVersion = mappedPersonality?.version ?? null;
        const mappedPersonaDefinitionId = mappedPersonality?.definitionId ?? null;
        const mappedPersonaSource = mappedPersonality
          ? state.personaCatalogSource
          : null;
        const connected = Boolean(session?.connected);
        const compareDraftCount = getCompareDraftCount();
        const availableRecaps = getAvailableFanSummaryModes(
          state,
          displayGroupId,
          mappedPersonalityId,
        );
        // Budgeted: a cold capability probe used to hold the whole popup empty
        // for up to AGENCY_HUB_PREFETCH_TIMEOUT_MS. Past the budget the hint is
        // false (fail closed) and the finished probe re-pushes tab state.
        const voiceNotesCapable = await voiceService?.resolveCapabilityFast(
          tabId,
          VOICE_CAPABILITY_BUDGET_MS,
        ) ?? false;

        return {
          tabId,
          accountId,
          groupId: displayGroupId,
          hasAvailableSummary: availableRecaps.full || availableRecaps.short,
          availableRecaps,
          connected,
          // Stage 32: readiness = kernel lane configured (hub transport up).
          hasApiKey: Boolean(
            normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl) &&
            (state.settings.agencyHubDeviceToken.trim() || state.settings.agencyHubApiKey.trim()),
          ),
          voiceNotesCapable,
          hasPersonalities: getActivePersonaCatalog(state.personaCatalog).length > 0,
          mappedPersonalityId,
          mappedPersonalityName,
          mappedPersonaVersion,
          mappedPersonaDefinitionId,
          mappedPersonaSource,
          compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
          compareDraftCount,
          // Popup-only headline. The persona name is DATA and stays verbatim;
          // the two fallbacks are structural sentinels rendered straight to the
          // chatter, so they speak Russian like the rest of the UI.
          accountLabel:
            mappedPersonalityName ??
            (accountId ? 'Аккаунт без персоны' : 'Не подключено'),
          accountName: formatSessionAccountName(session),
          // 'fan' is the operations-side placeholder when no real name
          // resolved — a placeholder is not a name.
          fanName:
            context.fanDisplayName && context.fanDisplayName !== 'fan'
              ? context.fanDisplayName
              : null,
          // Freshest same-day observation across pages: chatters run one
          // page per browser session, and resolving the exact label would
          // cost a hub round-trip the popup can't afford.
          aiQuota: await getLatestQuotaSnapshot(),
        } satisfies PopupStatus;
      }

      if (requestType === 'getAiQuotaStatus') {
        // Settings-page mirror of the popup's quota row: freshest same-day
        // observation or null — never a stale or made-up number.
        return await getLatestQuotaSnapshot();
      }

      if (requestType === 'getOpsDaily') {
        // Today's operational counters for the cabinet. Local read only — no
        // hub round-trip, no Fansly traffic.
        return await getOpsDaily();
      }

      if (requestType === 'getAgencyHubHealth' || requestType === 'getAgencyHubIdentity') {
        // Read a FRESH non-mutating snapshot, not the coordinator cache: a just-
        // saved hub can still be lagging behind storage.onChanged in the cache,
        // so a status read fired right after a save would otherwise probe the
        // PREVIOUS hub. readStorageState re-reads storage without writing back
        // (session discovery may own a concurrent identity rekey).
        const { settings } = await readStorageState();
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          AGENCY_HUB_PREFETCH_TIMEOUT_MS,
        );
        try {
          return requestType === 'getAgencyHubHealth'
            ? await agencyHubClient.checkHealth(settings, controller.signal)
            : await agencyHubClient.checkIdentity(settings, controller.signal);
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      if (requestType === 'getAiQuotaByPage') {
        return await getQuotaSnapshotsByPage();
      }

      if (requestType === 'getSpendersStatus') {
        // Scope the read to the CURRENT hub AND credential: a board observation
        // recorded under a previous hub/principal must not survive a hub change
        // OR a same-URL credential swap and paint a stale RAMPED/FLAG OFF row for
        // a principal the chatter is no longer signed in as. Fresh read so a
        // just-saved credential is not still lagging in the coordinator cache.
        const { settings } = await readStorageState();
        return await getLatestSpendersObservation(
          normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl),
          resolveHubBearer(settings),
        );
      }

      if (requestType === 'getAccountsView') {
        // The cabinet's «Аккаунты» rows. Local reads only — storage, the two
        // operational account stores, today's ops counters and `tabs.query`.
        // NOTHING here touches Fansly or the hub: this handler is called on every
        // mount and must not become egress (DP 1-B).
        //
        // The coordinator supplies the BARRIER only (its startup load, deferred
        // repair and the unsupported-future-schema assertion), never the answer:
        // `storage.local.set` resolves before `storage.onChanged` refreshes that
        // cache, so a persona the page just assigned or cleared would still read
        // stale here and the «AI отключён» badge would lie until the next poll.
        // The mappings/aliases/catalog therefore come from a FRESH non-mutating
        // snapshot — readStorageState never writes its snapshot back, so it
        // cannot clobber a concurrent background-owned identity rekey.
        await storageCoordinator.getState();
        const state = await readStorageState();
        const [presence, labels, opsDaily] = await Promise.all([
          getAccountPresence(),
          getAccountLabels(),
          getOpsDaily(),
        ]);

        // LIVE: a captured session in THIS worker's memory. `snapshot()` only
        // returns accounts that still hold a tab, so a tab id is knowable.
        const liveByAccountId = new Map<
          string,
          {
            username: string | null;
            displayName: string | null;
            legacyAccountId: string;
            lastSeenAt: number;
            tabId: number | null;
          }
        >();
        for (const session of sessionStore.snapshot()) {
          if (!session.connected) {
            continue;
          }
          const accountId = session.resolvedAccountId ?? session.legacyAccountId;
          const existing = liveByAccountId.get(accountId);
          // Two captures collided on one canonical account: the newest wins, so a
          // stale name can never shadow the live one.
          if (existing && existing.lastSeenAt >= session.lastSeenAt) {
            continue;
          }
          liveByAccountId.set(accountId, {
            username: session.username,
            displayName: session.displayName,
            legacyAccountId: session.legacyAccountId,
            lastSeenAt: session.lastSeenAt,
            tabId: sessionStore.getTabIdForAccount(accountId),
          });
        }

        const buildEntry = (
          accountId: string,
          fields: {
            state: AccountsViewEntry['state'];
            lastSeenAt: number | null;
            tabId: number | null;
            username: string | null;
            displayName: string | null;
            legacyAccountId?: string | null;
          },
        ): AccountsViewEntry => {
          const localLabel = labels.byAccount[accountId] ?? null;
          const mappedKey = resolveMappedPersonalityId(
            state.accountMappings,
            accountId,
            fields.legacyAccountId ?? null,
            state.accountAliases,
          );
          return {
            accountId,
            label: buildAccountRowLabel(
              accountId,
              localLabel,
              fields.username,
              fields.displayName,
            ),
            localLabel,
            state: fields.state,
            lastSeenAt: fields.lastSeenAt,
            tabId: fields.tabId,
            // An ARCHIVED mapping is not mapped: it cannot generate, so the row
            // must show the amber «AI отключён» rather than a false green.
            personaMapped: Boolean(findActivePersona(state.personaCatalog, mappedKey)),
            observedPage: opsDaily.pageByAccount[accountId] ?? null,
          };
        };

        const accounts: AccountsViewEntry[] = [];
        const claimed = new Set<string>();
        for (const [accountId, live] of liveByAccountId) {
          claimed.add(accountId);
          accounts.push(buildEntry(accountId, {
            state: 'live',
            // The durable record can lag the live session by up to the presence
            // store's coalescing window; either way this is «last seen», so take
            // the later moment rather than the staler one.
            lastSeenAt: Math.max(
              live.lastSeenAt,
              presence.byAccount[accountId]?.lastSeenAt ?? 0,
            ),
            tabId: live.tabId,
            username: live.username ?? presence.byAccount[accountId]?.username ?? null,
            displayName: live.displayName ?? presence.byAccount[accountId]?.displayName ?? null,
            legacyAccountId: live.legacyAccountId,
          }));
        }
        // SEEN: a durable presence record with no live session (typically a
        // worker restart, or a tab the chatter closed).
        for (const [accountId, entry] of Object.entries(presence.byAccount)) {
          if (claimed.has(accountId)) {
            continue;
          }
          claimed.add(accountId);
          accounts.push(buildEntry(accountId, {
            state: 'seen',
            lastSeenAt: entry.lastSeenAt,
            tabId: null,
            username: entry.username,
            displayName: entry.displayName,
          }));
        }
        // NEVER: a known account this browser holds no observation for at all
        // (a mapping restored from another device, or presence recorded before
        // this feature existed).
        for (const accountId of state.knownAccounts) {
          if (claimed.has(accountId)) {
            continue;
          }
          claimed.add(accountId);
          accounts.push(buildEntry(accountId, {
            state: 'never',
            lastSeenAt: null,
            tabId: null,
            username: null,
            displayName: null,
          }));
        }

        // Live first, then the freshest observation, then the never-seen —
        // ordered by how much the chatter can do with the row right now.
        const stateRank: Record<AccountsViewEntry['state'], number> = {
          live: 0,
          seen: 1,
          never: 2,
        };
        accounts.sort((left, right) => {
          if (stateRank[left.state] !== stateRank[right.state]) {
            return stateRank[left.state] - stateRank[right.state];
          }
          const byRecency = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
          return byRecency !== 0 ? byRecency : left.accountId.localeCompare(right.accountId);
        });

        // An AGGREGATE only. A fansly.com tab cannot be attributed to an account
        // after a worker restart (the capture map is gone and re-deriving it would
        // mean reading Fansly), so the pane says «N вкладок без атрибуции» rather
        // than inventing a per-account claim.
        let unattributedFanslyTabs = 0;
        try {
          const tabs = await browser.tabs.query({ url: FANSLY_TAB_URL_PATTERN });
          // The FULL capture map, not one tab per row: an account can hold
          // several captured tabs and every one of them IS attributed, while a
          // row can only carry a single tab id. Counting the extras here would
          // tell the chatter to «открой чат» for a chat that is already open.
          const attributedTabIds = sessionStore.getAttributedTabIds();
          unattributedFanslyTabs = tabs.filter(
            (tab) => tab.id === undefined || !attributedTabIds.has(tab.id),
          ).length;
        } catch {
          // No tabs answer is not "zero tabs": leave the aggregate at 0 so the
          // pane simply omits the line instead of claiming an empty browser.
        }

        return { accounts, unattributedFanslyTabs } satisfies AccountsView;
      }

      if (requestType === 'focusAccountTab') {
        const { accountId } = message as unknown as { accountId: string };
        const tabId = sessionStore.getTabIdForAccount(accountId.trim());
        if (tabId === null) {
          return { ok: false };
        }
        try {
          await browser.tabs.update(tabId, { active: true });
          // Activating a tab in a background window leaves it invisible — raise
          // its window too, so «к вкладке» actually shows the chat.
          const tab = await browser.tabs.get(tabId);
          if (tab.windowId !== undefined) {
            await browser.windows.update(tab.windowId, { focused: true });
          }
          return { ok: true };
        } catch {
          // The tab closed between the view read and the click.
          return { ok: false };
        }
      }

      if (requestType === 'setAccountLabel') {
        // The ONLY writer of `chatgoose:accountLabels`. The options page never
        // touches that key itself, so however many settings tabs are open there
        // is exactly one serialized path into it.
        const { accountId, label } = message as unknown as {
          accountId: string;
          label: string;
        };
        try {
          await setAccountLabel(accountId, label);
          return { ok: true };
        } catch (error) {
          logWarn('Account label write failed', {
            error: error instanceof Error ? error.message.slice(0, 200) : String(error),
          });
          // A rename the chatter typed either stuck or it did not — the pane has
          // to be able to say so instead of silently reverting on reload.
          return { ok: false };
        }
      }

      if (requestType === 'getOnboardingState') {
        return await readOnboardingState();
      }

      if (requestType === 'dismissOnboarding') {
        // Stamped only by the page that watched every step turn green, and only
        // once: a second call keeps the FIRST timestamp, so a later reload cannot
        // move the date the install finished setup.
        return await withOperationalWrite(async () => {
          try {
            const current = await readOnboardingState();
            if (current.dismissedAt !== null) {
              return { ok: true };
            }
            const next: OnboardingSnapshot = { version: 1, dismissedAt: Date.now() };
            await browser.storage.local.set({ [ONBOARDING_STORAGE_KEY]: next });
            return { ok: true };
          } catch (error) {
            // A failed stamp means the checklist comes back on the next open.
            // Annoying, never destructive — and the page must be able to know.
            logWarn('Onboarding dismissal write failed', {
              error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
            return { ok: false };
          }
        });
      }

      if (requestType === 'openOptions') {
        // Deep link from a surface that cannot route itself. Exactly ONE options
        // tab may exist: the page is a synchronous settings writer on pagehide,
        // so a second tab is a second writer racing the first over the same
        // blob. Re-point the open one instead of opening another.
        //
        // The whole lookup→reuse→create sequence runs under one lock: the check
        // and the create are separated by awaits, so concurrent requests must
        // not interleave across them (the second one then SEES the first one's
        // tab and re-points it).
        const { pane, code } = message as unknown as { pane: PaneKey; code?: string };
        return await withOpenOptionsLock(async () => {
          const pagePath = browser.runtime.getURL(OPTIONS_PAGE_PATH);
          const url = `${pagePath}${formatOptionsHash({ pane, code: code ?? null })}`;
          let existingTabId: number | undefined;
          try {
            // Match patterns ignore the fragment, so this finds the tab whatever
            // pane it is currently showing.
            const tabs = await browser.tabs.query({ url: `${pagePath}*` });
            existingTabId = tabs.find((tab) => tab.id !== undefined)?.id;
          } catch {
            // No answer is not «no tab open», but creating one is the only other
            // move available — and the reuse path is best-effort by nature.
          }
          if (existingTabId !== undefined) {
            try {
              // Same document, new hash: the page's hashchange listener paints the
              // pane and arms the highlight — no reload, no lost form state.
              await browser.tabs.update(existingTabId, { active: true, url });
              try {
                const tab = await browser.tabs.get(existingTabId);
                if (tab.windowId !== undefined) {
                  await browser.windows.update(tab.windowId, { focused: true });
                }
              } catch {
                // Raising the window is a nicety; the tab is already active.
              }
              return { opened: true, reused: true };
            } catch {
              // The tab closed between the query and the update — fall through.
            }
          }
          try {
            await browser.tabs.create({ url });
            return { opened: true, reused: false };
          } catch (error) {
            logWarn('Opening the settings page failed', {
              error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
            return { opened: false, reused: false };
          }
        });
      }

      if (requestType === 'getLastSeenVersion') {
        return await readLastSeenVersion();
      }

      if (requestType === 'setLastSeenVersion') {
        const { version } = message as unknown as { version: string };
        return await withOperationalWrite(async () => {
          try {
            const next: LastSeenVersionSnapshot = {
              version: 1,
              lastSeenVersion: version.trim(),
            };
            await browser.storage.local.set({ [LAST_SEEN_VERSION_STORAGE_KEY]: next });
            return { ok: true };
          } catch (error) {
            // The dot stays on until the write succeeds — an unread release note
            // is the safe side of this failure.
            logWarn('Last-seen version write failed', {
              error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
            return { ok: false };
          }
        });
      }

      if (requestType === 'getSessionsSnapshot') {
        const unresolvedSessions = sessionStore
          .getSessions()
          .filter(
            (session) =>
              session.connected &&
              (!session.resolvedAccountId ||
                (!session.resolvedUsername &&
                  !session.resolvedDisplayName)),
          );

        await Promise.allSettled(
          unresolvedSessions.map(async (session) => {
            const controller = new AbortController();
            const timeout = globalThis.setTimeout(
              () => controller.abort(),
              SESSION_IDENTITY_TIMEOUT_MS,
            );
            try {
              await fanslyClient.getAuthenticatedAccount(
                session,
                controller.signal,
              );
            } catch {
              // Best-effort enrichment for the options UI.
            } finally {
              globalThis.clearTimeout(timeout);
            }
          }),
        );

        const snapshot = sessionStore.snapshot();

        for (const session of snapshot) {
          if (
            session.resolvedAccountId &&
            session.resolvedAccountId !== session.legacyAccountId
          ) {
            await storageCoordinator.rekeyAccountIdentity(
              session.legacyAccountId,
              session.resolvedAccountId,
            );
          }
        }

        await storageCoordinator.reconcileKnownAccounts(
          snapshot.map(
            (session) => session.resolvedAccountId ?? session.legacyAccountId,
          ),
        );

        return snapshot;
      }

      // E28 viewer handshake. `openDebugPrompt` may come from the content script
      // (it holds the token but has no tabs API); `getDebugPromptSnapshot` — the
      // one call that hands over the assembled prompt — may come ONLY from the
      // viewer page itself.
      if (requestType === 'openDebugPrompt') {
        const { viewerToken } = message as unknown as { viewerToken: string };
        if (!debugPrompts.has(viewerToken)) {
          // Expired or from a dead service worker: don't open a tab that would
          // only greet the user with an error.
          return { opened: false };
        }
        await browser.tabs.create({
          url: browser.runtime.getURL(
            `${DEBUG_PROMPT_PAGE_PATH}?token=${encodeURIComponent(viewerToken)}`,
          ),
        });
        return { opened: true };
      }

      if (requestType === 'getDebugPromptSnapshot') {
        if (!isDebugPromptViewer(sender)) {
          return undefined;
        }
        const { viewerToken } = message as unknown as { viewerToken: string };
        const snapshot = debugPrompts.get(viewerToken);
        if (!snapshot) {
          return undefined;
        }
        return {
          feature: snapshot.feature,
          modelId: snapshot.modelId,
          capturedAtMs: snapshot.capturedAt,
          systemBlocks: snapshot.systemBlocks,
          userBlocks: snapshot.userBlocks,
          contextManifest: snapshot.contextManifest,
        };
      }

      if (requestType === 'testAgencyHubConnection') {
        const settings = isObjectRecord(message) &&
          isAgencyHubConnectionTestSettings(message.settings)
          ? message.settings
          : null;

        if (!settings) {
          return {
            ok: false,
            error: createUserError('hub_request_failed'),
          };
        }
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          AGENCY_HUB_PREFETCH_TIMEOUT_MS,
        );
        try {
          const response = await agencyHubClient.testConnection(settings, controller.signal);
          if (response.ok) {
            await onAgencyHubReady?.();
          }
          return response;
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      if (requestType === 'getAgencyHubDeviceTokenMeta') {
        // Read-only companion to the custody key: which token is live and when
        // it was issued. Never the token itself.
        return await readDeviceTokenMeta();
      }

      if (requestType === 'issueAgencyHubDeviceToken') {
        // Serialized against signOutAgencyHub so a concurrent sign-out cannot wipe
        // the token this handler is about to store, nor revoke a token this one
        // just replaced.
        return withAgencyHubCustodyLock(async () => {
          const input = isObjectRecord(message) &&
            typeof message.baseUrl === 'string' &&
            typeof message.username === 'string' &&
            typeof message.password === 'string'
            ? { baseUrl: message.baseUrl, username: message.username, password: message.password }
            : null;
          const baseUrl = input ? normalizeAgencyHubBaseUrl(input.baseUrl) : null;
          if (!input || !baseUrl || !input.username.trim() || !input.password) {
            return { ok: false, error: createUserError('hub_request_failed') };
          }
          try {
            const issued = await issueAgencyHubDeviceToken({
              baseUrl,
              username: input.username,
              password: input.password,
              label: `chatgoose-extension ${navigator.userAgent.includes('Firefox') ? 'firefox' : 'browser'}`,
            });
            const meta: AgencyHubDeviceTokenMeta = {
              version: 1,
              keyPrefix: issued.keyPrefix,
              issuedAt: Date.now(),
              expiresAt: issued.expiresAt,
              // WHICH hub minted this token. Sign-out revokes against this
              // address, so a later base-URL change cannot leave a live bearer
              // orphaned on the issuing hub. Never the token itself.
              issuedFrom: baseUrl,
            };
            // ONE atomic commit for the token AND its issuing-hub binding. The
            // token never crosses the runtime-message boundary — it lands
            // straight in its custody storage key (same custody class as the
            // legacy key), and `alsoWrite` puts the metadata in the SAME
            // storage.set. A separate best-effort meta write was the bug: a
            // re-issue against hub B that committed the token but lost the meta
            // write left `issuedFrom: A` on disk, so sign-out sent B's bearer to
            // A, A answered 401 → «already-invalid», and B's token stayed live.
            // Written inside the lock, so a concurrent sign-out can neither wipe
            // the token this write commits nor leave the meta describing it.
            await saveSettings(
              { agencyHubBaseUrl: baseUrl, agencyHubDeviceToken: issued.token },
              undefined,
              { alsoWrite: { [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: meta } },
            );
            return {
              ok: true,
              keyPrefix: issued.keyPrefix,
              label: issued.label,
              expiresAt: issued.expiresAt,
            };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof ChatGooseError
                ? toUserError(error)
                : createUserError('hub_request_failed'),
            };
          }
        });
      }

      if (requestType === 'signOutAgencyHub') {
        // Serialized against issueAgencyHubDeviceToken: the token is captured
        // INSIDE this critical section, immediately before the wipe, so a
        // concurrent sign-in can neither slip a fresh token past the wipe nor
        // have its token revoked here by mistake.
        return withAgencyHubCustodyLock(async () => {
          // (a) Capture the current token + base URL BEFORE the wipe. The token
          // never crosses the runtime boundary; the page only sees the outcome.
          // readStorageState, not loadStorageState: this is a pure read, and the
          // repair-write in loadStorageState could clobber a concurrent
          // rekey/reconcile with a pre-rekey snapshot.
          const before = await readStorageState();
          const capturedToken = before.settings.agencyHubDeviceToken.trim();
          // Revoke against the hub that ISSUED the token, not the address the
          // settings show now. If the base URL moved from hub A to hub B after
          // the token was issued, a revoke aimed at B returns 401/403, which
          // maps to `already-invalid` — the UI would report a clean sign-out
          // while the bearer stayed alive on A. Pre-`issuedFrom` records (and a
          // dropped/foreign metadata write) fall back to the captured address.
          const capturedMeta = await readDeviceTokenMeta();
          const capturedBaseUrl = capturedMeta?.issuedFrom || before.settings.agencyHubBaseUrl;
          // No recorded ADDRESS for the token that is stored: nothing on this
          // device knows which hub minted it. That covers an absent, foreign or
          // unreadable metadata record AND a valid pre-`issuedFrom` v1 record —
          // the latter is exactly the case that falls back to the CURRENT base URL
          // above, i.e. also a guess. The revoke below is then aimed at that
          // guess, so a 401/403 from it is not proof the bearer is dead — it is
          // equally the answer of a hub that never issued it. Such a revoke is
          // reported as `unreachable` («не подтверждён») further down; only a
          // recorded issuing address keeps the 401/403 → `already-invalid` mapping.
          const issuingHubUnknown = !capturedMeta?.issuedFrom;

          // (b) ALWAYS wipe both custody keys to EMPTY strings FIRST — the durable
          // step. Write ONLY the two top-level custody storage keys, never the
          // settings blob: a blob rewrite from the read snapshot above would
          // clobber a parallel tab's uiTheme/URL save that landed between the read
          // and this set (RMW race). The background outlives the options page, so
          // doing the wipe here (not on the page) means a pagehide during the 5s
          // revoke below can never leave the credentials on disk. EMPTY strings,
          // never key removal (removal would reopen the pre-v13 blob fallback —
          // E19).
          try {
            await browser.storage.local.set({
              [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
              [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
            });
          } catch (error) {
            // The loud case: credentials may still be on disk. Do NOT proceed to
            // revoke, and leave the metadata alone — it still describes what is
            // stored.
            const detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
            logWarn('Sign-out custody wipe failed', { error: detail });
            return { outcome: 'wipe-failed', error: detail };
          }
          // The metadata describes a token that no longer exists here.
          await clearDeviceTokenMeta();

          // (d) The SECOND, idempotent wipe. The revoke below can take up to 5s,
          // and the options page's debounced settings chain writes
          // `agencyHubApiKey` outside this lock: a delayed autosave (or a second
          // options tab) landing in that window would restore a usable legacy key
          // AFTER the wipe while this handler still reported `revoked`. Re-wiping
          // once the revoke has settled closes that window. EMPTY strings again,
          // never key removal (E19), and never the settings blob.
          const rewipeCustody = async (): Promise<string | null> => {
            try {
              await browser.storage.local.set({
                [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
                [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
              });
              return null;
            } catch (error) {
              return error instanceof Error ? error.message.slice(0, 200) : String(error);
            }
          };
          // A failed re-wipe is the loud case for the same reason the first wipe
          // is: a credential restored mid-revoke may still be on disk, and only
          // `wipe-failed` tells the chatter to look. It overrides the revoke's
          // own verdict on purpose — local custody outranks server truth here.
          const settle = async (
            outcome: AgencyHubSignOutResponse,
          ): Promise<AgencyHubSignOutResponse> => {
            const rewipeError = await rewipeCustody();
            if (rewipeError === null) {
              return outcome;
            }
            logWarn('Sign-out custody re-wipe failed', { error: rewipeError });
            return { outcome: 'wipe-failed', error: rewipeError };
          };

          // (c) Best-effort revoke AFTER the wipe, with the CAPTURED token as the
          // bearer (the stored copy is already ''). Nothing to revoke without one.
          if (!capturedToken) {
            return settle({ outcome: 'already-invalid' });
          }
          const controller = new AbortController();
          const timeout = globalThis.setTimeout(
            () => controller.abort(),
            AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS,
          );
          try {
            const outcome = await agencyHubClient.revokeDeviceToken(
              { agencyHubBaseUrl: capturedBaseUrl, agencyHubDeviceToken: capturedToken },
              controller.signal,
            );
            if (outcome === 'already-invalid' && issuingHubUnknown) {
              // A 401/403 from an address we only guessed at proves nothing about
              // the token: report the honest «не подтверждён» instead of claiming
              // a clean sign-out. Locally it is already wiped either way, and the
              // bearer dies by sliding-expiry if it really is still alive.
              logWarn('Device token revoke unconfirmed: no issuing-hub metadata', {
                baseUrl: capturedBaseUrl,
              });
              return await settle({ outcome: 'unreachable' });
            }
            return await settle({ outcome });
          } catch (error) {
            // Abort/network/5xx/missing-base-URL — server truth unknown. Already
            // wiped locally; the token dies by sliding-expiry.
            logWarn('Device token revoke unreachable', {
              error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
            return await settle({ outcome: 'unreachable' });
          } finally {
            globalThis.clearTimeout(timeout);
          }
        });
      }

      if (requestType === 'resolveFanChat') {
        const tabId = sender.tab?.id;
        const session = tabId !== undefined ? sessionStore.getSessionForTab(tabId) : null;
        if (!session || !session.connected) {
          return { ok: false, error: createUserError('not_connected') };
        }

        // Shape already validated by getRuntimeRequestType.
        const record = message as unknown as {
          fanAccountId: string;
          username: string | null;
          displayName: string | null;
        };
        const searchTerm = record.username?.trim() || record.displayName?.trim() || '';
        if (!searchTerm) {
          // Nothing to search by — an honest "not found", not an error.
          return { ok: true, groupId: null };
        }

        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          SPENDERS_RESOLVE_TIMEOUT_MS,
        );
        try {
          const groupId = await fanslyClient.findGroupIdForFan(
            record.fanAccountId,
            searchTerm,
            session,
            controller.signal,
          );
          return { ok: true, groupId };
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === 'AbortError';
          return {
            ok: false,
            error: timedOut ? createUserError('timed_out') : toUserError(error),
          };
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      if (requestType === 'getRecapStatus') {
        // Metadata-only recap-status read for the coach empty state (spec §5).
        // It must NEVER break opening Coach: any failure to REACH the Hub — not
        // connected, no page match, Hub down/absent — resolves to state
        // 'unavailable' (NOT null-slots-as-"no recap"; that dishonest collapse is
        // exactly the E43 empty-state trap). Only a Hub that actually answered
        // returns state 'ok' with real (possibly-null) slots.
        const unavailable: RecapStatusResponse = { state: 'unavailable', full: null, short: null };
        const tabId = sender.tab?.id;
        const session = tabId !== undefined ? sessionStore.getSessionForTab(tabId) : null;
        if (!session || !session.connected) {
          return unavailable;
        }
        // Shape already validated by getRuntimeRequestType (groupId non-empty).
        const record = message as unknown as {
          groupId: string;
          fanAccountId: string | null;
          personaDefinitionId: string;
        };
        const personaDefinitionId = record.personaDefinitionId.trim();
        // Coerce an empty/whitespace fanAccountId to null so '' takes the same
        // honest cold path as a missing fan — otherwise '' is a falsy fanRef the
        // client silently drops, leaving a groupId-only query that FALSELY confirms
        // "no recap" (P1-2, the '' half).
        const requestedFan = record.fanAccountId?.trim() || null;
        // The tab context (background's authoritative view, kept group-aligned by
        // the setRoute/setFan stale-fan guards) is the ONLY trusted fan source.
        const cachedContext = tabId !== undefined ? tabContexts.get(tabId) : null;
        const contextFanForGroup =
          cachedContext?.groupId === record.groupId ? cachedContext.fanAccountId : null;
        let resolvedFanRef: string | null;
        if (requestedFan !== null) {
          // An explicit fanAccountId from content is trusted ONLY when the context
          // confirms it for THIS group. Content's DOM fan id can lag an SPA
          // route-change (the A→B race rounds 12–13 hardened), so a fan the context
          // does not confirm for this group is a possible cross-group leak — fail
          // closed to 'unavailable' rather than query the Hub with (group B, fan A).
          if (requestedFan !== contextFanForGroup) {
            return unavailable;
          }
          resolvedFanRef = requestedFan;
        } else {
          resolvedFanRef = contextFanForGroup;
        }
        // COLD recap-status (P1-2): with no fanRef to search with (SW restart:
        // context has no cached fan), a groupId-only query can never find a
        // fan-id-keyed recap — a null-slots 200 would FALSELY read as "confirmed
        // no recap" and disable "open last recap". Report honest 'unavailable'
        // instead; the next op caches the fan and a later read checks for real.
        if (resolvedFanRef === null) {
          return unavailable;
        }
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          AGENCY_HUB_PREFETCH_TIMEOUT_MS,
        );
        try {
          // Resolve the page label the same way a generation does.
          const pageUsername =
            session.resolvedUsername?.trim() ||
            (await fanslyClient.getAuthenticatedAccount(session, controller.signal))
              ?.username?.trim() ||
            null;
          if (!pageUsername) {
            return unavailable;
          }
          const { settings } = await storageCoordinator.getState();
          const pageLabel = await agencyHubClient.resolvePageLabelForUsername(
            settings,
            pageUsername,
            controller.signal,
          );
          if (!pageLabel) {
            return unavailable;
          }
          const status = await agencyHubClient.getRecapStatus(
            settings,
            {
              pageLabel,
              // Canonical identity (§5): conversationRef = groupId, fanRef = fan.
              conversationRef: record.groupId,
              fanRef: resolvedFanRef,
              personaDefinitionId,
            },
            controller.signal,
          );
          return status;
        } catch (error) {
          logWarn('Recap status read failed; Coach opens recap-less', {
            reason: error instanceof Error ? error.message : String(error),
          });
          return unavailable;
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      if (requestType === 'getSpendersList') {
        const tabId = sender.tab?.id;
        const session = tabId !== undefined ? sessionStore.getSessionForTab(tabId) : null;
        if (!session || !session.connected) {
          return { ok: false, error: createUserError('not_connected') };
        }

        const refresh = isObjectRecord(message) && message.refresh === true;
        const buildId = isObjectRecord(message) && typeof message.buildId === 'string'
          ? message.buildId
          : undefined;
        const controller = new AbortController();
        // Stamp the abort with a real AbortError DOMException carrying the reason
        // so the getList wrapper can record a build timeout as a FAIL (not silently
        // skip it like a user-cancel / superseded build) AND so an aborted fetch
        // rejects with an AbortError — a bare string reason makes fetch reject with
        // that string, defeating the `instanceof DOMException` timeout classifier.
        const timeout = globalThis.setTimeout(
          () => controller.abort(new DOMException(SPENDERS_BUILD_TIMEOUT_REASON, 'AbortError')),
          SPENDERS_BUILD_TIMEOUT_MS,
        );
        try {
          const result = await spendersService.getList(session, controller.signal, {
            refresh,
            onProgress: emitToTab && tabId !== undefined
              ? (progress) => emitToTab(
                  tabId,
                  buildId === undefined ? progress : { ...progress, buildId },
                )
              : undefined,
            onSnapshot: emitToTab && tabId !== undefined
              ? (snapshot) => emitToTab(
                  tabId,
                  buildId === undefined ? snapshot : { ...snapshot, buildId },
                )
              : undefined,
          });
          return { ok: true, result };
        } catch (error) {
          // A build timeout: the caught error is an AbortError AND this handler's
          // own controller was aborted with the build-timeout reason. Reading the
          // reason off the controller (not the caught error) is robust — some
          // inner abort points rethrow a bare 'Aborted' DOMException that no
          // longer carries the reason.
          const reason: unknown = controller.signal.reason;
          const timedOut = error instanceof DOMException && error.name === 'AbortError' &&
            reason instanceof DOMException && reason.message === SPENDERS_BUILD_TIMEOUT_REASON;
          return {
            ok: false,
            error: timedOut ? createUserError('timed_out') : toUserError(error),
          };
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      return undefined;
    },
  );
}
