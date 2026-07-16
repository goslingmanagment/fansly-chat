import type { SessionSnapshotEntry } from '../shared/types.js';

function getNormalizedUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, '') ?? '';
  return normalized || null;
}

export function formatAccountHeading(
  accountId: string,
  session: SessionSnapshotEntry | null | undefined,
): string {
  const displayName = session?.displayName?.trim() || null;
  const username = getNormalizedUsername(session?.username);

  if (displayName && username && displayName.replace(/^@+/, '') !== username) {
    return `${displayName} (@${username})`;
  }
  if (username) {
    return `@${username}`;
  }
  if (displayName) {
    return displayName;
  }
  return session?.resolvedAccountId ?? accountId;
}

export function formatAccountMeta(
  accountId: string,
  session: SessionSnapshotEntry | null | undefined,
): string {
  const resolvedAccountId = session?.resolvedAccountId ?? accountId;
  return `ID аккаунта: ${resolvedAccountId}`;
}

export function buildSessionLookup(
  sessions: SessionSnapshotEntry[],
): Map<string, SessionSnapshotEntry> {
  const lookup = new Map<string, SessionSnapshotEntry>();
  const put = (key: string, session: SessionSnapshotEntry): void => {
    const existing = lookup.get(key);
    // Newest-wins: a duplicated account id (legacy + resolved keys, or two
    // snapshots for the same identity) resolves to the most recently seen
    // session so the merged Accounts row reflects the live capture.
    if (!existing || session.lastSeenAt > existing.lastSeenAt) {
      lookup.set(key, session);
    }
  };
  sessions.forEach((session) => {
    put(session.legacyAccountId, session);
    if (session.resolvedAccountId) {
      put(session.resolvedAccountId, session);
    }
  });
  return lookup;
}

export function formatCaptureStatus(session: SessionSnapshotEntry | undefined): string {
  if (!session?.connected) return 'нет сессии';
  const seenAt = session.lastSeenAt;
  if (!Number.isFinite(seenAt)) return 'захвачена только что';
  const minutes = Math.max(0, Math.round((Date.now() - seenAt) / 60_000));
  if (minutes === 0) return 'захвачена только что';
  if (minutes < 60) return `захвачена ${minutes} мин назад`;
  return `захвачена ${Math.round(minutes / 60)} ч назад`;
}
