import { describe, expect, it, vi } from 'vitest';
import { buildSessionLookup, formatCaptureStatus } from '../src/options/sessions.js';
import type { SessionSnapshotEntry } from '../src/shared/types.js';

// Local factory copying the exact field set of SessionSnapshotEntry
// (src/shared/types.ts). Required fields get inert values; only the fields
// under test vary through overrides.
function makeEntry(overrides: Partial<SessionSnapshotEntry> = {}): SessionSnapshotEntry {
  return {
    legacyAccountId: 'legacy',
    resolvedAccountId: null,
    username: null,
    displayName: null,
    connected: false,
    lastSeenAt: 0,
    ...overrides,
  };
}

describe('buildSessionLookup', () => {
  it('keeps the entry with the larger lastSeenAt regardless of array order', () => {
    const older = makeEntry({ resolvedAccountId: 'acc-1', lastSeenAt: 1_000, connected: false });
    const newer = makeEntry({ resolvedAccountId: 'acc-1', lastSeenAt: 2_000, connected: true });
    expect(buildSessionLookup([newer, older]).get('acc-1')).toBe(newer);
    expect(buildSessionLookup([older, newer]).get('acc-1')).toBe(newer);
  });
});

describe('formatCaptureStatus', () => {
  it('renders нет сессии / только что / minutes / hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
    expect(formatCaptureStatus(undefined)).toBe('нет сессии');
    expect(formatCaptureStatus(makeEntry({ connected: false }))).toBe('нет сессии');
    expect(formatCaptureStatus(makeEntry({ connected: true, lastSeenAt: Date.now() }))).toBe('захвачена только что');
    expect(formatCaptureStatus(makeEntry({ connected: true, lastSeenAt: Date.now() - 5 * 60_000 }))).toBe('захвачена 5 мин назад');
    expect(formatCaptureStatus(makeEntry({ connected: true, lastSeenAt: Date.now() - 3 * 3_600_000 }))).toBe('захвачена 3 ч назад');
    vi.useRealTimers();
  });
});
