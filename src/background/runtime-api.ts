import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_REASON,
  SPENDERS_RESOLVE_TIMEOUT_MS,
} from '../shared/constants.js';
import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { createUserError, toUserError } from '../shared/errors.js';
import {
  getRuntimeRequestType,
  isAgencyHubConnectionTestSettings,
  isObjectRecord,
} from '../shared/protocol.js';
import { hasAvailableFanSummary } from '../shared/summary-cache.js';
import { findActivePersona, getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { loadStorageState, readStorageState, saveSettings } from '../shared/storage.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { ChatGooseError } from '../shared/errors.js';
import { logWarn } from '../shared/log.js';
import { issueAgencyHubDeviceToken } from './device-token.js';
import type {
  PopupStatus,
  SpendersBuildPayload,
} from '../shared/types.js';
import { resolveHubBearer, type AgencyHubClient } from './agency-hub-client.js';
import type { DebugPromptStore } from './debug-prompt-store.js';
import type { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { getLatestQuotaSnapshot, getQuotaSnapshotsByPage } from './quota-tracker.js';
import { getLatestSpendersObservation } from './spenders-status-tracker.js';
import type { SessionStore } from './session-store.js';
import type { SpendersService } from './spenders-service.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

// Serialize the two device-token custody mutations — sign-in (issue + store) and
// sign-out (capture + wipe + revoke) — through one FIFO promise queue. Without
// it, a sign-in landing mid-sign-out could interleave so a freshly issued token
// is stored locally, then the sign-out's wipe erases it while its revoke kills a
// DIFFERENT (captured) token — leaving a live, un-revocable token orphaned on the
// hub. Under the lock each critical section (which captures the token to revoke
// only INSIDE the section, right before the wipe) runs to completion before the
// next begins, so the two never observe each other's half-written state.
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
}

/** E28. The prompt echo is readable by ONE caller: our own viewer page. The
 * content script running inside fansly.com must not be able to ask for it — it
 * shares a document with the site's JS, and a compromised page could otherwise
 * walk the runtime API to the persona and the dossier. Compare the sender's
 * origin AND path (not a prefix — `debug-prompt.html.evil` starts with it too);
 * the query string is where the token rides, so it is excluded from the match. */
export const DEBUG_PROMPT_PAGE_PATH = 'debug-prompt.html';

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
}: RuntimeApiDeps): void {
  browser.runtime.onMessage.addListener(
    async (message: unknown, sender: browser.runtime.MessageSender) => {
      const requestType = getRuntimeRequestType(message);
      if (!requestType) {
        return undefined;
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
            connected: false,
            hasApiKey: false,
            hasPersonalities: false,
            mappedPersonalityId: null,
            mappedPersonalityName: null,
            mappedPersonaVersion: null,
            mappedPersonaDefinitionId: null,
            mappedPersonaSource: null,
            compareCardCount: 0,
            compareDraftCount: 0,
            accountLabel: 'Not connected',
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

        return {
          tabId,
          accountId,
          groupId: displayGroupId,
          hasAvailableSummary: hasAvailableFanSummary(
            state,
            displayGroupId,
            mappedPersonalityId,
          ),
          connected,
          // Stage 32: readiness = kernel lane configured (hub transport up).
          hasApiKey: Boolean(
            normalizeAgencyHubBaseUrl(state.settings.agencyHubBaseUrl) &&
            (state.settings.agencyHubDeviceToken.trim() || state.settings.agencyHubApiKey.trim()),
          ),
          hasPersonalities: getActivePersonaCatalog(state.personaCatalog).length > 0,
          mappedPersonalityId,
          mappedPersonalityName,
          mappedPersonaVersion,
          mappedPersonaDefinitionId,
          mappedPersonaSource,
          compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
          compareDraftCount,
          accountLabel:
            mappedPersonalityName ??
            (accountId ? 'Unmapped account' : 'Not connected'),
          // Freshest same-day observation across pages: chatters run one
          // page per browser session, and resolving the exact label would
          // cost a hub round-trip the popup can't afford.
          aiQuota: await getLatestQuotaSnapshot(),
        } satisfies PopupStatus;
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

      if (requestType === 'issueAgencyHubDeviceToken') {
        // Serialized against signOutAgencyHub so a concurrent sign-out cannot wipe
        // the token this handler is about to store, nor revoke a token this one
        // just replaced (Task 4 mutex).
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
            // The token never crosses the runtime-message boundary — it lands
            // straight in settings storage (same custody class as the key).
            await saveSettings({ agencyHubBaseUrl: baseUrl, agencyHubDeviceToken: issued.token });
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
        // Serialized against issueAgencyHubDeviceToken (Task 4 mutex): the token is
        // captured INSIDE this critical section, immediately before the wipe, so a
        // concurrent sign-in can neither slip a fresh token past the wipe nor have
        // its token revoked here by mistake.
        return withAgencyHubCustodyLock(async () => {
          // (a) Capture the current token + base URL BEFORE the wipe. The token never
          // crosses the runtime boundary; the page only sees the outcome.
          // readStorageState, not loadStorageState: this is a pure read, and the
          // repair-write in loadStorageState could clobber a concurrent
          // rekey/reconcile with a pre-rekey snapshot (same rule as the sibling
          // hub handlers above).
          const before = await readStorageState();
          const capturedToken = before.settings.agencyHubDeviceToken.trim();
          const capturedBaseUrl = before.settings.agencyHubBaseUrl;

          // (b) ALWAYS wipe both custody keys to EMPTY strings FIRST — the durable step.
          // Write ONLY the two top-level custody storage keys, never the settings blob:
          // a blob rewrite from the read snapshot above would clobber a parallel tab's
          // uiTheme/URL save that landed between the read and this set (RMW race). The
          // background outlives the options page, so doing the wipe here (not on the
          // page) means a pagehide during the 5s revoke below can never leave the
          // credentials on disk. EMPTY strings, never key removal (removal would reopen
          // the pre-v13 blob fallback — E19).
          try {
            await browser.storage.local.set({
              [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
              [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
            });
          } catch (error) {
            // The loud case: credentials may still be on disk. Do NOT proceed to revoke.
            const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
            logWarn('Sign-out custody wipe failed', { error: message });
            return { outcome: 'wipe-failed', error: message };
          }

          // (c) Best-effort revoke AFTER the wipe, with the CAPTURED token as the bearer
          // (the stored copy is already ''). Nothing to revoke without a token.
          if (!capturedToken) {
            return { outcome: 'already-invalid' };
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
            return { outcome };
          } catch (error) {
            // Abort/network/5xx/missing-base-URL — server truth unknown. Already wiped
            // locally; the token dies by sliding-expiry.
            logWarn('Device token revoke unreachable', {
              error: error instanceof Error ? error.message.slice(0, 200) : String(error),
            });
            return { outcome: 'unreachable' };
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
