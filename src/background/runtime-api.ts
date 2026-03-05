import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { loadStorageState } from '../shared/storage.js';
import type { PopupStatus } from '../shared/types.js';
import { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { SessionStore } from './session-store.js';
import { TabContextStore } from './tab-context.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

export interface RuntimeApiDeps {
  fanslyClient: FanslyClient;
  sessionStore: SessionStore;
  tabContexts: TabContextStore;
}

export function registerRuntimeApi({
  fanslyClient,
  sessionStore,
  tabContexts,
}: RuntimeApiDeps): void {
  browser.runtime.onMessage.addListener(
    async (message: { type: string; tabId?: number }) => {
      if (message.type === 'getPopupStatus') {
        const [activeTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const tabId = message.tabId ?? activeTab?.id;
        const tabUrl = activeTab?.url;

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

        const state = await loadStorageState();
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

        return sessionStore.snapshot();
      }

      return undefined;
    },
  );
}
