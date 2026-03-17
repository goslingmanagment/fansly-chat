import { hasClaudeApiKey } from '../shared/claude-api.js';
import { DEFAULT_MODEL_ID } from '../shared/constants.js';
import { getCompareDraftCount, resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { getProviderDiagnostics } from '../shared/provider-runtime.js';
import type { PopupStatus } from '../shared/types.js';
import type { AnthropicClient } from './anthropic-client.js';
import { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { SessionStore } from './session-store.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

export interface RuntimeApiDeps {
  anthropicClient: AnthropicClient;
  fanslyClient: FanslyClient;
  sessionStore: SessionStore;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
}

export function registerRuntimeApi({
  anthropicClient,
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
        const state = await storageCoordinator.getState();
        const providerDiagnostics = await getProviderDiagnostics(state.settings);

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
            claudeProvider: 'anthropic',
            hasApiKey: false,
            hasPersonalities: false,
            mappedPersonalityId: null,
            mappedPersonalityName: null,
            compareCardCount: 0,
            compareDraftCount: 0,
            accountLabel: 'Not connected',
            providerDiagnostics,
          } satisfies PopupStatus;
        }

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
          claudeProvider: state.settings.claudeProvider,
          hasApiKey: hasClaudeApiKey(state.settings),
          hasPersonalities: state.personalities.length > 0,
          mappedPersonalityId,
          mappedPersonalityName,
          compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
          compareDraftCount,
          accountLabel:
            mappedPersonalityName ??
            (accountId ? 'Unmapped account' : 'Not connected'),
          providerDiagnostics,
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

      if (message.type === 'getProviderDiagnostics') {
        const state = await storageCoordinator.getState();
        return getProviderDiagnostics(state.settings);
      }

      if (message.type === 'runProviderConnectionTest') {
        const state = await storageCoordinator.getState();
        const resolvedModel =
          state.settings.featureModels['fast-reply'] ?? DEFAULT_MODEL_ID;
        return anthropicClient.testConnection({
          provider: state.settings.claudeProvider,
          apiKey:
            state.settings.claudeProvider === 'kiro'
              ? state.settings.kiroApiKey
              : state.settings.anthropicApiKey,
          model: resolvedModel,
          debugEnabled: Boolean(state.settings.debugMode),
        });
      }

      return undefined;
    },
  );
}
