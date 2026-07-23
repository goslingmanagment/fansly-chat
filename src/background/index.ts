import { AgencyHubClient } from './agency-hub-client.js';
import { createAcceptanceReporter } from './acceptance-reporter.js';
import { createKernelFeatureGateway } from './kernel-feature-gateway.js';
import {
  createPersonaCatalogController,
  startPersonaCatalogRefreshLoop,
} from './persona-catalog.js';
import { FanslyClient } from './fansly-client.js';
import { OperationCoordinator } from './operations.js';
import { registerRuntimeApi } from './runtime-api.js';
import { initializeSessionCapture } from './session-capture.js';
import { SessionStore } from './session-store.js';
import { SpendersService } from './spenders-service.js';
import {
  shouldInvalidateSpendersForStorageChanges,
  tabRefreshMessageForStorageChanges,
} from './storage-change-policy.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';
import { VoiceAttemptRepository } from './voice-attempt-store.js';
import { VoiceService } from './voice-service.js';
import { readStorageState } from '../shared/storage.js';

// ─── Composition Root (DI, no module-level mutable state) ───────────────

const sessionStore = new SessionStore();
const tabContexts = new TabContextStore();
const storageCoordinator = new StorageCoordinator();
const voiceAttempts = new VoiceAttemptRepository();
const fanslyClient = new FanslyClient(sessionStore);
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
);
coordinator.setVoiceCapabilityResolver((tabId) => voiceService.resolveCapability(tabId));

browser.runtime.onConnect.addListener((port) => {
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
    void personaCatalog.refresh()
      .catch((error) => console.warn('[persona-catalog] source refresh failed', error));
  }
  const refreshMessage = tabRefreshMessageForStorageChanges(changes, areaName);
  if (refreshMessage !== null) {
    void coordinator.refreshAllTabs(refreshMessage);
  }
});

void storageCoordinator.init().then(() => {
  void personaCatalog.refresh()
    .catch((error) => console.warn('[persona-catalog] startup refresh failed', error));
  // W9.4/A40: one startup flush — events spooled when the previous background
  // instance died must not wait for the NEXT enqueue's debounce to deliver.
  void acceptanceReporter.flushNow().catch((error) => {
    console.warn('[acceptance] startup flush failed', error);
  });
});
