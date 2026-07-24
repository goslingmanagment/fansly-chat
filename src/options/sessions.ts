import type { SessionSnapshotEntry } from '../shared/types.js';

function getNormalizedUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, '') ?? '';
  return normalized || null;
}

/** 18-digit Fansly ids don't read as headings; show enough to tell accounts
 * apart. The full id stays available in the «ID аккаунта:» meta line. */
export function shortenAccountId(accountId: string): string {
  return accountId.length > 12
    ? `${accountId.slice(0, 4)}…${accountId.slice(-4)}`
    : accountId;
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
  return shortenAccountId(session?.resolvedAccountId ?? accountId);
}

export function buildSessionLookup(
  sessions: SessionSnapshotEntry[],
): Map<string, SessionSnapshotEntry> {
  const lookup = new Map<string, SessionSnapshotEntry>();
  // Newest wins on key collisions — two captures of the same canonical
  // account must not let a stale name shadow the live one.
  const put = (key: string, session: SessionSnapshotEntry): void => {
    const existing = lookup.get(key);
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
