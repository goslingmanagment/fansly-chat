import { describe, expect, it } from 'vitest';
import {
  shouldInvalidateSpendersForStorageChanges,
  shouldRefreshTabsForStorageChanges,
  tabRefreshMessageForStorageChanges,
} from '../src/background/storage-change-policy.js';

/**
 * Tests for Bug 7: storage.onChanged filtering logic.
 *
 * The filter in src/background/index.ts uses an allowlist of UI-relevant keys
 * and checks areaName === 'local'. We test the filtering logic directly rather
 * than importing index.ts (which has heavy side effects).
 */

function change(oldValue: unknown, newValue: unknown): browser.storage.StorageChange {
  return { oldValue, newValue };
}

describe('storage.onChanged filter logic (Bug 7)', () => {
  it('ignores changes from non-local area', () => {
    expect(shouldRefreshTabsForStorageChanges({ settings: {} }, 'sync')).toBe(false);
    expect(shouldRefreshTabsForStorageChanges({ settings: {} }, 'managed')).toBe(false);
  });

  it('ignores summary cache key changes', () => {
    expect(shouldRefreshTabsForStorageChanges({ 'summary:group-123': {} }, 'local')).toBe(false);
    expect(shouldRefreshTabsForStorageChanges({ 'summary:abc': {}, 'summary:def': {} }, 'local')).toBe(false);
  });

  it('triggers refresh for settings key', () => {
    expect(shouldRefreshTabsForStorageChanges({ settings: {} }, 'local')).toBe(true);
  });

  it('ignores preserved legacy personalities changes', () => {
    expect(shouldRefreshTabsForStorageChanges({ personalities: {} }, 'local')).toBe(false);
  });

  it('triggers refresh for server persona catalog changes', () => {
    expect(shouldRefreshTabsForStorageChanges({ personaCatalog: {} }, 'local')).toBe(true);
    expect(tabRefreshMessageForStorageChanges({ personaCatalog: {} }, 'local'))
      .toBe('mapping:changed');
  });

  it('ignores catalog freshness timestamps and routes mapping changes narrowly', () => {
    expect(shouldRefreshTabsForStorageChanges({ personaCatalogFetchedAt: {} }, 'local')).toBe(false);
    expect(tabRefreshMessageForStorageChanges({ personaCatalogFetchedAt: {} }, 'local')).toBeNull();
    expect(tabRefreshMessageForStorageChanges({ accountMappings: {} }, 'local'))
      .toBe('mapping:changed');
    expect(tabRefreshMessageForStorageChanges({ settings: {}, personaCatalog: {} }, 'local'))
      .toBe('mapping:changed');
  });

  it('triggers refresh for accountMappings key', () => {
    expect(shouldRefreshTabsForStorageChanges({ accountMappings: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for accountAliases key', () => {
    expect(shouldRefreshTabsForStorageChanges({ accountAliases: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for knownAccounts key', () => {
    expect(shouldRefreshTabsForStorageChanges({ knownAccounts: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for schemaVersion key', () => {
    expect(shouldRefreshTabsForStorageChanges({ schemaVersion: {} }, 'local')).toBe(true);
  });

  it('triggers refresh when mix of relevant and irrelevant keys', () => {
    expect(shouldRefreshTabsForStorageChanges({ 'summary:foo': {}, settings: {} }, 'local')).toBe(true);
  });

  it('ignores unknown non-summary keys', () => {
    expect(shouldRefreshTabsForStorageChanges({ randomKey: {} }, 'local')).toBe(false);
  });

  it('ignores the private startup listener probe', () => {
    const changes = {
      __chatgooseStorageListenerProbeV1: change(undefined, 'probe'),
      __chatgooseStorageRepairAckV1: change(undefined, 'ack'),
    };
    expect(shouldRefreshTabsForStorageChanges(changes, 'local')).toBe(false);
    expect(shouldInvalidateSpendersForStorageChanges(changes, 'local')).toBe(false);
  });
});

describe('Spenders invalidation policy', () => {
  const baseSettings = {
    agencyHubBaseUrl: 'https://hub.example.com',
    debugMode: false,
    quickMessageCount: 100,
  };

  it('keeps the board cache for unrelated settings edits', () => {
    expect(shouldInvalidateSpendersForStorageChanges({
      settings: change(baseSettings, { ...baseSettings, debugMode: true }),
    }, 'local')).toBe(false);
    expect(shouldInvalidateSpendersForStorageChanges({
      settings: change(baseSettings, { ...baseSettings, quickMessageCount: 250 }),
    }, 'local')).toBe(false);
    expect(shouldInvalidateSpendersForStorageChanges({
      settings: change(baseSettings, { ...baseSettings, uiTheme: 'dark' }),
    }, 'local')).toBe(false);
  });

  it('invalidates for a changed Hub source URL but not equivalent normalization', () => {
    const changedSource = {
      settings: change(baseSettings, {
        ...baseSettings,
        agencyHubBaseUrl: 'https://other.example.com',
      }),
    };
    expect(shouldInvalidateSpendersForStorageChanges(changedSource, 'local')).toBe(true);
    expect(tabRefreshMessageForStorageChanges(changedSource, 'local')).toBe('settings:changed');
    expect(shouldInvalidateSpendersForStorageChanges({
      settings: change(baseSettings, {
        ...baseSettings,
        agencyHubBaseUrl: 'https://hub.example.com/',
      }),
    }, 'local')).toBe(false);
  });

  it('invalidates for either credential custody key only in local storage', () => {
    expect(shouldInvalidateSpendersForStorageChanges({
      agencyHubDeviceToken: change('old-token', 'new-token'),
    }, 'local')).toBe(true);
    expect(shouldInvalidateSpendersForStorageChanges({
      agencyHubApiKey: change('old-key', 'new-key'),
    }, 'local')).toBe(true);
    expect(shouldInvalidateSpendersForStorageChanges({
      agencyHubApiKey: change('old-key', 'new-key'),
    }, 'sync')).toBe(false);
  });
});
