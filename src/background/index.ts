import { AgencyHubClient } from './agency-hub-client.js';
import { createAcceptanceReporter } from './acceptance-reporter.js';
import { createKernelFeatureGateway } from './kernel-feature-gateway.js';
import { createPersonaSync } from './persona-sync.js';
import { FanslyClient } from './fansly-client.js';
import { OperationCoordinator } from './operations.js';
import { registerRuntimeApi } from './runtime-api.js';
import { initializeSessionCapture } from './session-capture.js';
import { SessionStore } from './session-store.js';
import { SpendersService } from './spenders-service.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';

// ─── Composition Root (DI, no module-level mutable state) ───────────────

const sessionStore = new SessionStore();
const tabContexts = new TabContextStore();
const storageCoordinator = new StorageCoordinator();
const fanslyClient = new FanslyClient(sessionStore);
const spendersService = new SpendersService(
  fanslyClient,
  {
    resolvePageLabelForUsername: (settings, pageUsername, signal) =>
      agencyHubClient.resolvePageLabelForUsername(settings, pageUsername, signal),
    fetchTopSpenders: (settings, pageLabel, limit, signal) =>
      agencyHubClient.fetchTopSpenders(settings, pageLabel, limit, signal),
  },
  async () => (await storageCoordinator.getState()).settings,
);
const agencyHubClient = new AgencyHubClient();
const kernelGateway = createKernelFeatureGateway();
// Stage 32 Task 5: acceptance telemetry on the capture lane (drop-oldest
// spool in storage.local — recoverable signal, not custody-grade audit).
const acceptanceReporter = createAcceptanceReporter({
  storage: browser.storage.local,
  getSettings: async () => (await storageCoordinator.getState()).settings,
});
// W9.2/A7: keep kernel ai_personas in step with local personalities — saves
// diff via storage.onChanged below, boot reconcile heals pre-1.8.1 gaps.
const personaSync = createPersonaSync({
  hub: agencyHubClient,
  getSettings: async () => (await storageCoordinator.getState()).settings,
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

browser.runtime.onConnect.addListener((port) => {
  coordinator.registerPort(port);
});

initializeSessionCapture(sessionStore, async (tabId, accountId) => {
  await storageCoordinator.registerKnownAccount(accountId);
  await coordinator.handleCapture(tabId, accountId);
});

registerRuntimeApi({
  agencyHubClient,
  fanslyClient,
  sessionStore,
  spendersService,
  tabContexts,
  storageCoordinator,
});

browser.tabs.onRemoved.addListener((tabId) => {
  void coordinator.handleTabRemoved(tabId);
});

const UI_RELEVANT_KEYS = new Set([
  'settings',
  'personalities',
  'accountMappings',
  'accountAliases',
  'knownAccounts',
  'schemaVersion',
]);

browser.storage.onChanged.addListener((changes, areaName) => {
  storageCoordinator.applyStorageChanges(changes, areaName);
  if (areaName !== 'local') return;
  if (changes.personalities) {
    void personaSync.handlePersonalitiesChange(
      changes.personalities.oldValue,
      changes.personalities.newValue,
    );
  }
  const hasRelevantKey = Object.keys(changes).some((k) => UI_RELEVANT_KEYS.has(k));
  if (hasRelevantKey) {
    void coordinator.refreshAllTabs('settings:changed');
  }
});

void storageCoordinator.init().then((state) => {
  // W9.2/A7 boot reconcile: heal kernel personas for accounts whose custom
  // personality predates the sync (the pre-1.8.1 "Unknown persona" 400s).
  void personaSync.reconcile(state.personalities);
});
