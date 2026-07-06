import {
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_MS,
} from '../shared/constants.js';
import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { createUserError, toUserError } from '../shared/errors.js';
import {
  getRuntimeRequestType,
  isAgencyHubConnectionTestSettings,
  isObjectRecord,
} from '../shared/protocol.js';
import { hasAvailableFanSummary } from '../shared/summary-cache.js';
import { saveSettings } from '../shared/storage.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { ChatGooseError } from '../shared/errors.js';
import { issueAgencyHubDeviceToken } from './device-token.js';
import type {
  PopupStatus,
} from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import type { SessionStore } from './session-store.js';
import type { SpendersService } from './spenders-service.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

export interface RuntimeApiDeps {
  agencyHubClient: AgencyHubClient;
  fanslyClient: FanslyClient;
  sessionStore: SessionStore;
  spendersService: SpendersService;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
}

export function registerRuntimeApi({
  agencyHubClient,
  fanslyClient,
  sessionStore,
  spendersService,
  tabContexts,
  storageCoordinator,
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
            compareCardCount: 0,
            compareDraftCount: 0,
            accountLabel: 'Not connected',
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

        const mappedPersonalityId = resolveMappedPersonalityId(
          state.accountMappings,
          accountId,
          legacyAccountId,
          state.accountAliases,
        );
        const mappedPersonalityName =
          state.personalities.find((p) => p.id === mappedPersonalityId)
            ?.name ?? null;
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
          hasPersonalities: state.personalities.length > 0,
          mappedPersonalityId,
          mappedPersonalityName,
          compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
          compareDraftCount,
          accountLabel:
            mappedPersonalityName ??
            (accountId ? 'Unmapped account' : 'Not connected'),
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
          return await agencyHubClient.testConnection(settings, controller.signal);
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }

      if (requestType === 'issueAgencyHubDeviceToken') {
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
      }

      if (requestType === 'getSpendersList') {
        const tabId = sender.tab?.id;
        const session = tabId !== undefined ? sessionStore.getSessionForTab(tabId) : null;
        if (!session || !session.connected) {
          return { ok: false, error: createUserError('not_connected') };
        }

        const refresh = isObjectRecord(message) && message.refresh === true;
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          SPENDERS_BUILD_TIMEOUT_MS,
        );
        try {
          const result = await spendersService.getList(session, controller.signal, { refresh });
          return { ok: true, result };
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

      return undefined;
    },
  );
}
