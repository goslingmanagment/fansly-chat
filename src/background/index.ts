import { AgencyHubClient } from './agency-hub-client.js';
import { AgencyHubUsageReporter } from './agency-hub-usage-reporter.js';
import { AnthropicClient } from './anthropic-client.js';
import { FanslyClient } from './fansly-client.js';
import { LlmClient } from './llm-client.js';
import { OpenRouterClient } from './openrouter-client.js';
import { OperationCoordinator } from './operations.js';
import { registerRuntimeApi } from './runtime-api.js';
import { initializeSessionCapture } from './session-capture.js';
import { SessionStore } from './session-store.js';
import { StorageCoordinator } from './storage-coordinator.js';
import { TabContextStore } from './tab-context.js';

// ─── Composition Root (DI, no module-level mutable state) ───────────────

const sessionStore = new SessionStore();
const tabContexts = new TabContextStore();
const storageCoordinator = new StorageCoordinator();
const fanslyClient = new FanslyClient(sessionStore);
const anthropicClient = new AnthropicClient();
const openRouterClient = new OpenRouterClient();
const llmClient = new LlmClient(anthropicClient, openRouterClient);
const agencyHubClient = new AgencyHubClient();
const agencyHubUsageReporter = new AgencyHubUsageReporter(agencyHubClient);
const coordinator = new OperationCoordinator(
  sessionStore,
  tabContexts,
  fanslyClient,
  llmClient,
  storageCoordinator,
  agencyHubClient,
  agencyHubUsageReporter,
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
  const hasRelevantKey = Object.keys(changes).some((k) => UI_RELEVANT_KEYS.has(k));
  if (hasRelevantKey) {
    void coordinator.refreshAllTabs('settings:changed');
  }
});

void storageCoordinator.init();
