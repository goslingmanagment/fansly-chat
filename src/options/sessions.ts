import { COPY } from './copy.js';
import type { SessionSnapshotEntry } from '../shared/types.js';

/** Age of the captured Fansly session — the honest thing the settings page can
 * say about a live account. It is NOT «the chatter is on the tab»: this page has
 * no tab attribution, only the moment the background last saw traffic. */
export function formatCaptureStatus(session: SessionSnapshotEntry | undefined): string {
  if (!session?.connected) return COPY.status.captureNone;
  const seenAt = session.lastSeenAt;
  if (!Number.isFinite(seenAt)) return COPY.status.captureJustNow;
  const minutes = Math.max(0, Math.round((Date.now() - seenAt) / 60_000));
  if (minutes === 0) return COPY.status.captureJustNow;
  if (minutes < 60) return COPY.status.captureMinutes.replace('{n}', String(minutes));
  return COPY.status.captureHours.replace('{n}', String(Math.round(minutes / 60)));
}

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
