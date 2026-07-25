// Durable "this browser has seen this Fansly account" memory for the cabinet's
// «Аккаунты» pane.
//
// SessionStore lives in the MV3 worker's memory: after a suspension every
// account looks like it was never here. The pane must still be able to say «была
// вчера 21:40» instead of «сессий не было», so the last-seen moment (plus the
// names identity resolution produced) lands in durable storage.
//
// Custody: its OWN operational storage.local key with its OWN `version` field —
// never the settings blob (whose schema stays v15) and never a custody key. A
// malformed or foreign-version record is discarded rather than migrated: this is
// an observation log, not user data.
//
// Write discipline: ONE module-level FIFO queue (the ops-daily / quota-tracker
// pattern), because storage.local.set replaces the whole record.
//
// Cadence: a LEADING write plus a 30s coalescing window per account. Every
// Fansly request the chatter's tab makes is a capture, so writing each one would
// hammer storage; but a TRAILING debounce is wrong here — MV3 can suspend the
// worker before the tail fires and the observation would be lost outright. So
// the first capture of a window writes immediately and the rest are dropped;
// `lastSeenAt` is at most 30s stale, and never invented.
//
// An identity UPGRADE (a username/displayName this store has not recorded yet)
// bypasses the window: names are null at capture time and only appear after
// `account/me` resolves, and «была вчера» next to a bare id is a worse answer
// than one extra write.

import type { AccountPresenceEntry, AccountPresenceSnapshot } from '../shared/types.js';

export type { AccountPresenceEntry, AccountPresenceSnapshot };

const STORAGE_KEY = 'chatgoose:accountPresence';
/** Leading-write window per account. */
const PRESENCE_COALESCE_MS = 30_000;

let memoryFallback: AccountPresenceSnapshot | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
/** What the last accepted write for an account carried — the coalescing window
 * and the identity-upgrade check both read it, so neither needs a storage read
 * on the capture hot path. */
const lastWrites = new Map<string, { at: number; username: string | null; displayName: string | null }>();

function localStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.local ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptySnapshot(): AccountPresenceSnapshot {
  return { version: 1, byAccount: {} };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Accept only a well-formed v1 record; anything else becomes an empty one
 * rather than a half-trusted mixture. */
function normalize(raw: unknown): AccountPresenceSnapshot {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.byAccount)) {
    return emptySnapshot();
  }
  const byAccount: Record<string, AccountPresenceEntry> = {};
  for (const [accountId, entry] of Object.entries(raw.byAccount)) {
    if (!accountId || !isRecord(entry) || typeof entry.lastSeenAt !== 'number') {
      continue;
    }
    byAccount[accountId] = {
      lastSeenAt: entry.lastSeenAt,
      username: nullableString(entry.username),
      displayName: nullableString(entry.displayName),
    };
  }
  return { version: 1, byAccount };
}

async function read(): Promise<AccountPresenceSnapshot> {
  const area = localStorageArea();
  if (!area) {
    return memoryFallback ?? emptySnapshot();
  }
  try {
    const raw = await area.get(STORAGE_KEY);
    return normalize(raw[STORAGE_KEY]);
  } catch {
    return memoryFallback ?? emptySnapshot();
  }
}

async function write(snapshot: AccountPresenceSnapshot): Promise<void> {
  memoryFallback = snapshot;
  const area = localStorageArea();
  if (!area) {
    return;
  }
  try {
    await area.set({ [STORAGE_KEY]: snapshot });
  } catch {
    // Presence is an observation for a settings pane: a failed write must never
    // break the capture or the identity resolution that recorded it. The memory
    // copy above does NOT rescue this update — `read` prefers a storage area
    // whose `get` works, so an area that reads but fails to write keeps serving
    // the stale disk record. It only covers an area failing on read too.
  }
}

/** Serialize a read-modify-write of the whole record. Each queued task re-reads
 * the freshest snapshot before applying its own change, so overlapping
 * recorders compose instead of clobbering.
 *
 * `apply` returns whether it CHANGED anything, and a false answer skips the
 * write entirely. storage.local.set replaces the whole record, so an
 * unconditional write would churn the disk for nothing — and this is not a rare
 * path: `rekeyAccountIdentity` calls `transferAccountPresence` on EVERY
 * `getSessionsSnapshot` while a legacy-id session is open (an options mount plus
 * a ≥5s focus/visibility repoll), long after the one real transfer happened. */
async function mutate(apply: (snapshot: AccountPresenceSnapshot) => boolean): Promise<void> {
  const run = mutationQueue.then(async () => {
    const snapshot = await read();
    if (!apply(snapshot)) {
      return;
    }
    await write(snapshot);
  });
  // Keep the queue usable after a storage failure; each caller awaits its own
  // ordered attempt.
  mutationQueue = run.catch(() => undefined);
  await mutationQueue;
}

/**
 * Note that this browser just saw `accountId` live.
 *
 * `username`/`displayName` are optional and NEVER erase a stored name: the
 * capture hook has no identity yet, so passing null there must not wipe what
 * `account/me` resolved earlier.
 */
export async function recordAccountPresence(entry: {
  accountId: string;
  username?: string | null;
  displayName?: string | null;
}): Promise<void> {
  const accountId = entry.accountId?.trim();
  if (!accountId) {
    return;
  }
  const username = nullableString(entry.username);
  const displayName = nullableString(entry.displayName);
  const now = Date.now();
  const previous = lastWrites.get(accountId);
  // A name this store has not written yet is worth a write of its own.
  const identityUpgrade =
    (username !== null && username !== previous?.username) ||
    (displayName !== null && displayName !== previous?.displayName);
  if (previous && !identityUpgrade && now - previous.at < PRESENCE_COALESCE_MS) {
    return;
  }
  // Claim the window BEFORE awaiting, so a burst of captures inside one tick
  // collapses into this single leading write.
  lastWrites.set(accountId, {
    at: now,
    username: username ?? previous?.username ?? null,
    displayName: displayName ?? previous?.displayName ?? null,
  });
  await mutate((snapshot) => {
    const stored = snapshot.byAccount[accountId];
    const next: AccountPresenceEntry = {
      lastSeenAt: now,
      username: username ?? stored?.username ?? null,
      displayName: displayName ?? stored?.displayName ?? null,
    };
    if (
      stored &&
      stored.lastSeenAt === next.lastSeenAt &&
      stored.username === next.username &&
      stored.displayName === next.displayName
    ) {
      return false;
    }
    snapshot.byAccount[accountId] = next;
    return true;
  });
}

/**
 * Move a legacy account's presence onto the canonical id discovered by identity
 * resolution. The CANONICAL record wins on conflict (it is keyed by the id every
 * other store now uses) and the legacy record is removed, so the pane never
 * shows the same account twice.
 */
export async function transferAccountPresence(
  legacyAccountId: string,
  canonicalAccountId: string,
): Promise<void> {
  if (!legacyAccountId || !canonicalAccountId || legacyAccountId === canonicalAccountId) {
    return;
  }
  lastWrites.delete(legacyAccountId);
  await mutate((snapshot) => {
    const legacy = snapshot.byAccount[legacyAccountId];
    if (!legacy) {
      // Nothing to move: the transfer already ran (or this account never had a
      // legacy record). The rekey calls it on every repoll, so this must not
      // write.
      return false;
    }
    delete snapshot.byAccount[legacyAccountId];
    const canonical = snapshot.byAccount[canonicalAccountId];
    if (canonical) {
      // Canonical wins; only take the strictly fresher moment and any name it
      // is still missing.
      snapshot.byAccount[canonicalAccountId] = {
        lastSeenAt: Math.max(canonical.lastSeenAt, legacy.lastSeenAt),
        username: canonical.username ?? legacy.username,
        displayName: canonical.displayName ?? legacy.displayName,
      };
      // The legacy key was deleted above, so the record changed even when the
      // canonical entry kept every one of its own fields.
      return true;
    }
    snapshot.byAccount[canonicalAccountId] = legacy;
    return true;
  });
}

export async function getAccountPresence(): Promise<AccountPresenceSnapshot> {
  // Let any queued mutation land first, so a record that just resolved is
  // visible to the very next read.
  await mutationQueue;
  return read();
}

/** Test seam: drop the in-memory copies so a fresh case starts clean. */
export function resetAccountPresenceMemory(): void {
  memoryFallback = null;
  lastWrites.clear();
}
