import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';

const UI_RELEVANT_KEYS = new Set([
  'settings',
  'agencyHubDeviceToken',
  'agencyHubApiKey',
  'personaCatalog',
  'personaCatalogSource',
  'personaCatalogFetchedAt',
  'accountMappings',
  'accountAliases',
  'knownAccounts',
  'schemaVersion',
]);

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
  return areaName === 'local' &&
    Object.keys(changes).some((key) => UI_RELEVANT_KEYS.has(key));
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
