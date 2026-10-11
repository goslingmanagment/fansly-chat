import { AgencyHubClient } from './agency-hub-client.js';
import { createAcceptanceReporter } from './acceptance-reporter.js';
import { createKernelFeatureGateway } from './kernel-feature-gateway.js';
import {
  createPersonaCatalogController,
  startPersonaCatalogRefreshLoop,
} from './persona-catalog.js';
import { FanslyClient } from './fansly-client.js';
import { createFanslyRelayHub, createFanslyTransport } from './fansly-transport.js';
import { OperationCoordinator } from './operations.js';
import { registerRuntimeApi } from './runtime-api.js';
import { initializeSessionCapture } from './session-capture.js';
import { SessionStore } from './session-store.js';
import { SpendersService } from './spenders-service.js';
import {
  shouldInvalidateSpendersForStorageChanges,
  tabRefreshMessageForStorageChanges,
} from './storage-change-policy.js';
import { clearSpendersObservations } from './spenders-status-tracker.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';
import { VoiceAttemptRepository } from './voice-attempt-store.js';
import { VoiceService } from './voice-service.js';
import {
  DEFAULT_AGENCY_HUB_BASE_URL,
  VOICE_CAPABILITY_BUDGET_MS,
} from '../shared/constants.js';
import { buildAgencyHubOriginPattern } from '../shared/agency-hub.js';
import { FANSLY_RELAY_PORT_NAME } from '../shared/fansly-relay-protocol.js';
import { readStorageState } from '../shared/storage.js';
import { FollowersService } from './followers-service.js';
import { WelcomeDefinitionsService } from './welcome-definitions.js';
import { registerFollowersRuntime } from './followers-runtime.js';
import { createMessageSoundPlayer } from './message-sound-player.js';
import { focusedFanslyConversation, registerMessageSoundRuntime } from './message-sound-runtime.js';
import { MessageSoundService } from './message-sound-service.js';

// ─── Composition Root (DI, no module-level mutable state) ───────────────

const sessionStore = new SessionStore();
const tabContexts = new TabContextStore();
const storageCoordinator = new StorageCoordinator();
const voiceAttempts = new VoiceAttemptRepository();
// E149: «Fansly через вкладку». Off, every request leaves from the background
// as before; on, it rides the relay frame of a tab holding the same session.
const fanslyRelays = createFanslyRelayHub();
const fanslyClient = new FanslyClient(sessionStore, browser.storage.local, createFanslyTransport({
  viaTab: async () => (await storageCoordinator.getState()).settings.fanslyViaTab,
  tabsFor: (session) => sessionStore.getTabIdsForAccount(session.accountId),
  relays: fanslyRelays,
}));
const spendersService = new SpendersService(
  fanslyClient,
  {
    resolvePageLabelForUsername: (settings, pageUsername, signal) =>
      agencyHubClient.resolvePageLabelForUsername(settings, pageUsername, signal),
    fetchTopSpenders: (settings, pageLabel, window, limit, signal) =>
      agencyHubClient.fetchTopSpenders(settings, pageLabel, window, limit, signal),
  },
  async () => (await storageCoordinator.getState()).settings,
);
const agencyHubClient = new AgencyHubClient();
// Stage 32 Task 5: acceptance telemetry on the capture lane (drop-oldest
// spool in storage.local — recoverable signal, not custody-grade audit).
const acceptanceReporter = createAcceptanceReporter({
  storage: browser.storage.local,
  getSettings: async () => (await storageCoordinator.getState()).settings,
  // W9.4/A18+A40: drops were silent — the reporter's warnings now reach the
  // background console.
  onWarn: (message) => console.warn(message),
});
const personaCatalog = createPersonaCatalogController({
  hub: agencyHubClient,
  storage: browser.storage.local,
  readSettings: async () => (await readStorageState()).settings,
  onWarn: (message) => console.warn(message),
});
const kernelGateway = createKernelFeatureGateway(
  undefined,
  () => personaCatalog.refresh(),
);
// ONE instance for both Hi surfaces: the New Followers window and the chat Hi
// share the 24 h cache and the one-paced-read-per-creator rule.
const welcomeDefinitions = new WelcomeDefinitionsService({
  fansly: fanslyClient,
  storage: browser.storage.local,
});
registerFollowersRuntime(new FollowersService({
  fansly: fanslyClient, sessions: sessionStore, gateway: kernelGateway, hub: agencyHubClient,
  readState: readStorageState, storage: browser.storage.local, welcome: welcomeDefinitions,
}));
// E145: the incoming-message sound. Reads the page's own socket through the
// content tap; plays here, where Firefox allows audio without a click.
registerMessageSoundRuntime(new MessageSoundService({
  getState: () => storageCoordinator.getState(),
  getTabSession: (tabId) => {
    const session = sessionStore.getSessionForTab(tabId);
    return session
      ? { accountId: session.accountId, resolvedAccountId: session.resolvedAccountId }
      : null;
  },
  isTabOpen: async (tabId) => {
    try {
      await browser.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
  focusedConversationGroupId: () => focusedFanslyConversation(browser.windows),
  // An unloaded (discarded) tab runs no scripts — it is not «missing a reload».
  listFanslyTabIds: async () => (await browser.tabs.query({ url: '*://fansly.com/*', discarded: false }))
    .flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
  player: createMessageSoundPlayer(),
  now: () => Date.now(),
  monotonic: () => performance.now(),
}));
const voiceService = new VoiceService({
  kernelGateway,
  agencyHubClient,
  fanslyClient,
  sessionStore,
  tabContexts,
  storageCoordinator,
  voiceAttempts,
});
// A persistent content port can keep this MV3 worker alive for a whole shift.
// Refresh while alive so an owner archive/revision does not stay stale until
// the browser restarts; suspension/restart is covered by the startup refresh.
startPersonaCatalogRefreshLoop({
  refresh: () => personaCatalog.refresh(),
  onWarn: (message) => console.warn(message),
});
const coordinator = new OperationCoordinator(
  sessionStore,
  tabContexts,
  fanslyClient,
  kernelGateway,
  storageCoordinator,
  agencyHubClient,
  acceptanceReporter,
  undefined,
  welcomeDefinitions,
);
// First paint wins the race against a cold capability probe: tab:init state
// assembly waits at most VOICE_CAPABILITY_BUDGET_MS and takes the fail-closed
// `false` past it. The probe keeps running (it also resolves the session's
// canonical identity), and its late success re-pushes tab state below.
coordinator.setVoiceCapabilityResolver((tabId) =>
  voiceService.resolveCapabilityFast(tabId, VOICE_CAPABILITY_BUDGET_MS),
);
// Wired AFTER the coordinator exists — voiceService is constructed before it,
// so this cannot be a constructor dependency.
voiceService.setOnCapabilityResolvedLate((tabId) => {
  void coordinator.refreshTabState(tabId, 'tab:state');
});

const bootstrapKeepalivePorts = new Set<browser.runtime.Port>();
browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'chatgoose-bootstrap') {
    // The tiny global content shell preserves the historical MV3 lifetime for
    // the five-minute persona refresh loop, but it has no operational protocol.
    // Do not make non-chat tabs participate in tab-state/voice broadcasts.
    bootstrapKeepalivePorts.add(port);
    port.onDisconnect.addListener(() => {
      bootstrapKeepalivePorts.delete(port);
    });
    return;
  }
  if (port.name === FANSLY_RELAY_PORT_NAME) {
    fanslyRelays.register(port);
    return;
  }
  coordinator.registerPort(port);
  voiceService.registerPort(port);
});

initializeSessionCapture(sessionStore, async (tabId, accountId, material) => {
  if (material) {
    try {
      await storageCoordinator.registerKnownAccount(accountId);
    } catch (error) {
      // Known-account persistence must not block session identity recovery.
      console.warn('[session-capture] failed to persist known account', error);
    }
  }
  await coordinator.handleCapture(tabId, accountId, material);
});

registerRuntimeApi({
  agencyHubClient,
  fanslyClient,
  sessionStore,
  spendersService,
  tabContexts,
  storageCoordinator,
  debugPrompts: coordinator.debugPrompts,
  // The board rides a one-shot runtime request; its cold-build progress goes
  // back over the tab's existing content port.
  emitToTab: (tabId, message) => coordinator.sendToTab(tabId, message),
  onAgencyHubReady: async () => {
    await personaCatalog.refresh();
  },
  voiceService,
  voiceAttempts,
});

browser.tabs.onRemoved.addListener((tabId) => {
  voiceService.handleTabRemoved(tabId);
  void coordinator.handleTabRemoved(tabId);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  storageCoordinator.applyStorageChanges(changes, areaName);
  if (areaName !== 'local') return;
  const hubSourceChanged = shouldInvalidateSpendersForStorageChanges(changes, areaName);
  if (hubSourceChanged) {
    // The board cache is source-scoped. A same-URL credential replacement can
    // still change data visibility, so clear both memory and storage.session.
    void spendersService.invalidateAll();
    // The status observations are keyed by hub+credential fingerprint, but the
    // freshest-eligible lookup could still surface a same-URL observation from
    // the previous principal until a new board is opened. Clear them too.
    void clearSpendersObservations();
    void personaCatalog.refresh()
      .catch((error) => console.warn('[persona-catalog] source refresh failed', error));
  }
  const refreshMessage = tabRefreshMessageForStorageChanges(changes, areaName);
  if (refreshMessage !== null) {
    void coordinator.refreshAllTabs(refreshMessage);
  }
});

// Firefox grants `host_permissions` in the INSTALL prompt only — an extension
// that gains a new origin in an update gets nothing (bug 1893232). So the one
// fact worth recording at this moment is whether this profile actually holds
// the hub origin: a fresh install does, an upgraded one does not and will be
// asked on the first «Войти». Status only — a listener cannot request a
// permission, that needs a user gesture.
if (typeof browser.runtime.onInstalled?.addListener === 'function') {
  browser.runtime.onInstalled.addListener((details) => {
    const origin = buildAgencyHubOriginPattern(DEFAULT_AGENCY_HUB_BASE_URL);
    if (!origin || typeof browser.permissions?.contains !== 'function') return;
    void browser.permissions.contains({ origins: [origin] })
      .then((granted) => {
        console.info(
          `[host-access] ${details.reason}: ${origin} ${granted ? 'granted' : 'not granted'}`,
        );
      })
      .catch((error: unknown) => {
        console.warn('[host-access] permission check failed', error);
      });
  });
}

void storageCoordinator.init().then(() => {
  void personaCatalog.refresh()
    .catch((error) => console.warn('[persona-catalog] startup refresh failed', error));
  // W9.4/A40: one startup flush — events spooled when the previous background
  // instance died must not wait for the NEXT enqueue's debounce to deliver.
  void acceptanceReporter.flushNow().catch((error) => {
    console.warn('[acceptance] startup flush failed', error);
  });
});
