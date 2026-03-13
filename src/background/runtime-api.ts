import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import type { PopupStatus } from '../shared/types.js';
import { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { SessionStore } from './session-store.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

export interface RuntimeApiDeps {
  fanslyClient: FanslyClient;
  sessionStore: SessionStore;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
}

export function registerRuntimeApi({
  fanslyClient,
  sessionStore,
  tabContexts,
  storageCoordinator,
}: RuntimeApiDeps): void {
  browser.runtime.onMessage.addListener(
    async (message: { type: string; tabId?: number }) => {
      if (message.type === 'getPopupStatus') {
        let tabId: number | undefined;
        let tabUrl: string | undefined;

        if (message.tabId !== undefined) {
          const tab = await browser.tabs.get(message.tabId);
          tabId = tab.id ?? message.tabId;
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
        context.groupId = parseGroupIdFromUrl(tabUrl) ?? context.groupId;
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
          groupId: context.groupId,
          connected,
          hasApiKey: Boolean(state.settings.claudeApiKey),
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

      if (message.type === 'getSessionsSnapshot') {
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

      return undefined;
    },
  );
}
