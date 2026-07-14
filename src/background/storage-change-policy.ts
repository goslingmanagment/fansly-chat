import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';

const UI_RELEVANT_KEYS = new Set([
  'settings',
  'agencyHubDeviceToken',
  'agencyHubApiKey',
  'personaCatalog',
  'personaCatalogSource',
  'accountMappings',
  'accountAliases',
  'knownAccounts',
  'schemaVersion',
]);

export type TabRefreshMessage = 'settings:changed' | 'mapping:changed';

function hubBaseUrlFromSettings(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const baseUrl = (value as Record<string, unknown>).agencyHubBaseUrl;
  return typeof baseUrl === 'string' ? normalizeAgencyHubBaseUrl(baseUrl) : '';
}

export function shouldRefreshTabsForStorageChanges(
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string,
): boolean {
  return tabRefreshMessageForStorageChanges(changes, areaName) !== null;
}

/**
 * Catalog timestamps are operational metadata, not UI context. Catalog and
 * mapping changes refresh persona state without invalidating unrelated UI such
 * as an open Spenders board; only real settings/source context uses the broad
 * settings event.
 */
export function tabRefreshMessageForStorageChanges(
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string,
): TabRefreshMessage | null {
  if (areaName !== 'local') {
    return null;
  }
  const keys = Object.keys(changes);
  if (shouldInvalidateSpendersForStorageChanges(changes, areaName)) {
    return 'settings:changed';
  }
  if (keys.some((key) => UI_RELEVANT_KEYS.has(key))) {
    return 'mapping:changed';
  }
  return null;
}

export function shouldInvalidateSpendersForStorageChanges(
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string,
): boolean {
  if (areaName !== 'local') {
    return false;
  }

  // Credentials have dedicated v13 custody keys. A change can alter the
  // visible Hub pages even when the URL remains the same.
  if (changes.agencyHubDeviceToken || changes.agencyHubApiKey) {
    return true;
  }

  const settingsChange = changes.settings;
  if (!settingsChange) {
    return false;
  }

  // Theme, debug and message-count edits do not change the Spenders source.
  // Compare the normalized Hub origin only, rather than invalidating on every
  // full settings-blob write.
  return hubBaseUrlFromSettings(settingsChange.oldValue) !==
    hubBaseUrlFromSettings(settingsChange.newValue);
}
