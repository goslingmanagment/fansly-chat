import {
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_MS,
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
import { logWarn } from '../shared/log.js';
import { findActivePersona, getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { saveSettings } from '../shared/storage.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { ChatGooseError } from '../shared/errors.js';
import { issueAgencyHubDeviceToken } from './device-token.js';
import type {
  PopupStatus,
  RecapStatusResponse,
  SpendersBuildPayload,
} from '../shared/types.js';
import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreSnapshot,
} from '../shared/voice-attempt.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { DebugPromptStore } from './debug-prompt-store.js';
import type { FanslyClient } from './fansly-client.js';
import { parseGroupIdFromUrl } from './operation-utils.js';
import { getLatestQuotaSnapshot } from './quota-tracker.js';
import type { SessionStore } from './session-store.js';
import type { SpendersService } from './spenders-service.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';
import type { VoiceService } from './voice-service.js';
import type { VoiceAttemptRepository } from './voice-attempt-store.js';

const SESSION_IDENTITY_TIMEOUT_MS = 5_000;

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
  /** Fail-closed page capability resolver shared with tab:init state. */
  voiceService?: Pick<VoiceService, 'resolveCapability'>;
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
  const rawUrl = sender?.url ?? sender?.tab?.url;
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
  if (
    (context?.groupId !== null && context?.groupId !== undefined && context.groupId !== groupId) ||
    (context?.accountId && context.accountId !== route.accountId)
  ) {
    return null;
  }
  const session = sessionStore.getSessionForTab(tabId);
  const reliableAccounts = new Set(
    [session?.accountId, session?.resolvedAccountId]
      .filter((accountId): accountId is string => Boolean(accountId)),
  );
  if (reliableAccounts.size > 0 && !reliableAccounts.has(route.accountId)) {
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
          return { version: 1, ok: false, error: 'invalid_sender' } as const;
        }
        const entries = await voiceAttempts.load(route);
        return { version: 1, ok: true, entries } as const;
      }

      if (requestType === 'voiceAttemptSave') {
        const { snapshot } = message as { snapshot: VoiceAttemptStoreSnapshot };
        if (
          !voiceAttemptSender(
            sender,
            snapshot.attempt.boundRoute,
            sessionStore,
            tabContexts,
          )
        ) {
          return { version: 1, ok: false, error: 'invalid_sender' } as const;
        }
        await voiceAttempts.save(snapshot);
        return { version: 1, ok: true } as const;
      }

      if (requestType === 'voiceAttemptRemove') {
        const { attemptId, route } = message as {
          attemptId: string;
          route: StoredVoiceAttemptRoute;
        };
        if (!voiceAttemptSender(sender, route, sessionStore, tabContexts)) {
          return { version: 1, ok: false, error: 'invalid_sender' } as const;
        }
        await voiceAttempts.remove(attemptId, route);
        return { version: 1, ok: true } as const;
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
        const voiceNotesCapable = await voiceService?.resolveCapability(tabId) ?? false;

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
          voiceNotesCapable,
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
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
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
