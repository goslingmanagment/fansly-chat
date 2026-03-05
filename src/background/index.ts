import { loadStorageState } from '../shared/storage.js';
import { AnthropicClient } from './anthropic-client.js';
import { FanslyClient } from './fansly-client.js';
import { OperationCoordinator } from './operations.js';
import { registerRuntimeApi } from './runtime-api.js';
import { initializeSessionCapture } from './session-capture.js';
import { SessionStore } from './session-store.js';
import { TabContextStore } from './tab-context.js';

// ─── Composition Root (DI, no module-level mutable state) ───────────────

const sessionStore = new SessionStore();
const tabContexts = new TabContextStore();
const fanslyClient = new FanslyClient(sessionStore);
const anthropicClient = new AnthropicClient();
const coordinator = new OperationCoordinator(
  sessionStore,
  tabContexts,
  fanslyClient,
  anthropicClient,
);

browser.runtime.onConnect.addListener((port) => {
  coordinator.registerPort(port);
});

initializeSessionCapture(sessionStore, (tabId, accountId) => {
  void coordinator.handleCapture(tabId, accountId);
});

registerRuntimeApi({ fanslyClient, sessionStore, tabContexts });

browser.tabs.onRemoved.addListener((tabId) => {
  void coordinator.handleTabRemoved(tabId);
});

const UI_RELEVANT_KEYS = new Set([
  'settings',
  'personalities',
  'accountMappings',
  'knownAccounts',
  'schemaVersion',
]);

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const hasRelevantKey = Object.keys(changes).some((k) => UI_RELEVANT_KEYS.has(k));
  if (hasRelevantKey) {
    void coordinator.refreshAllTabs('settings:changed');
  }
});

void loadStorageState();
