import type { SessionSnapshotEntry } from '../shared/types.js';

function getNormalizedUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, '') ?? '';
  return normalized || null;
}

/** 18-digit Fansly ids don't read as headings; show enough to tell accounts
 * apart. The full id stays available in the "Account ID:" meta line. */
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

export function formatAccountMeta(
  accountId: string,
  session: SessionSnapshotEntry | null | undefined,
): string {
  const resolvedAccountId = session?.resolvedAccountId ?? accountId;
  return `Account ID: ${resolvedAccountId}`;
}

export function buildSessionLookup(
  sessions: SessionSnapshotEntry[],
): Map<string, SessionSnapshotEntry> {
  const lookup = new Map<string, SessionSnapshotEntry>();

  sessions.forEach((session) => {
    lookup.set(session.legacyAccountId, session);
    if (session.resolvedAccountId) {
      lookup.set(session.resolvedAccountId, session);
    }
  });

  return lookup;
}

export function buildConnectionRows(
  sessions: SessionSnapshotEntry[],
): Array<{ accountId: string; session: SessionSnapshotEntry }> {
  const deduped = new Map<string, SessionSnapshotEntry>();

  sessions.forEach((session) => {
    const canonicalAccountId = session.resolvedAccountId ?? session.legacyAccountId;
    const existing = deduped.get(canonicalAccountId);
    if (!existing || session.lastSeenAt > existing.lastSeenAt) {
      deduped.set(canonicalAccountId, session);
    }
  });

  return Array.from(deduped.entries()).map(([accountId, session]) => ({
    accountId,
    session,
  }));
}
