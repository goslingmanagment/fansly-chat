import { describe, expect, it } from 'vitest';

/**
 * Tests for Bug 7: storage.onChanged filtering logic.
 *
 * The filter in src/background/index.ts uses an allowlist of UI-relevant keys
 * and checks areaName === 'local'. We test the filtering logic directly rather
 * than importing index.ts (which has heavy side effects).
 */

const UI_RELEVANT_KEYS = new Set([
  'settings',
  'personalities',
  'accountMappings',
  'knownAccounts',
  'schemaVersion',
]);

function shouldRefresh(changes: Record<string, unknown>, areaName: string): boolean {
  if (areaName !== 'local') return false;
  return Object.keys(changes).some((k) => UI_RELEVANT_KEYS.has(k));
}

describe('storage.onChanged filter logic (Bug 7)', () => {
  it('ignores changes from non-local area', () => {
    expect(shouldRefresh({ settings: {} }, 'sync')).toBe(false);
    expect(shouldRefresh({ settings: {} }, 'managed')).toBe(false);
  });

  it('ignores summary cache key changes', () => {
    expect(shouldRefresh({ 'summary:group-123': {} }, 'local')).toBe(false);
    expect(shouldRefresh({ 'summary:abc': {}, 'summary:def': {} }, 'local')).toBe(false);
  });

  it('triggers refresh for settings key', () => {
    expect(shouldRefresh({ settings: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for personalities key', () => {
    expect(shouldRefresh({ personalities: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for accountMappings key', () => {
    expect(shouldRefresh({ accountMappings: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for knownAccounts key', () => {
    expect(shouldRefresh({ knownAccounts: {} }, 'local')).toBe(true);
  });

  it('triggers refresh for schemaVersion key', () => {
    expect(shouldRefresh({ schemaVersion: {} }, 'local')).toBe(true);
  });

  it('triggers refresh when mix of relevant and irrelevant keys', () => {
    expect(shouldRefresh({ 'summary:foo': {}, settings: {} }, 'local')).toBe(true);
  });

  it('ignores unknown non-summary keys', () => {
    expect(shouldRefresh({ randomKey: {} }, 'local')).toBe(false);
  });
});
