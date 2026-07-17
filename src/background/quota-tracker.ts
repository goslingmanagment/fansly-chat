// AI-quota snapshot tracker. The kernel's meta frame carries a per-request
// quota snapshot (remaining requests / micro-USD for the UTC day); the
// gateway used to drop it. This module keeps the freshest snapshot per page
// so the popup can show quota state BEFORE a chatter hits the 429 wall.
//
// Custody: storage.session (survives event-page restarts, dies with the
// browser session, never syncs). Snapshots are day-scoped — a snapshot from
// a previous UTC day is expired at read time (the kernel resets at 00:00
// UTC). Falls back to module memory when storage.session is unavailable
// (unit tests / exotic builds).

import type { AiQuotaStatus } from '../shared/types.js';

export type AiQuotaSnapshot = AiQuotaStatus;

const STORAGE_KEY = 'aiQuotaByPage';

let memoryFallback: Record<string, AiQuotaSnapshot> = {};

// storage.session updates replace the whole per-page object. Serialize every
// read-modify-write so two overlapping generations (different pages) cannot both
// read the same snapshot and let the later writer erase the earlier page's
// entry. Mirrors the spenders session-cache queue in spenders-service.
let mutationQueue: Promise<void> = Promise.resolve();

function sessionStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function readAll(): Promise<Record<string, AiQuotaSnapshot>> {
  const area = sessionStorageArea();
  if (!area) {
    return memoryFallback;
  }
  try {
    const raw = await area.get(STORAGE_KEY);
    const value = raw[STORAGE_KEY];
    return value && typeof value === 'object'
      ? (value as Record<string, AiQuotaSnapshot>)
      : {};
  } catch {
    return memoryFallback;
  }
}

async function writeAll(snapshots: Record<string, AiQuotaSnapshot>): Promise<void> {
  memoryFallback = snapshots;
  const area = sessionStorageArea();
  if (!area) {
    return;
  }
  try {
    await area.set({ [STORAGE_KEY]: snapshots });
  } catch {
    // Memory fallback already holds the data; session storage is best-effort.
  }
}

/** Serialize a read-modify-write of the whole per-page map. Each queued task
 * re-reads the freshest snapshot before applying its own change, so overlapping
 * generations compose instead of clobbering. */
async function mutateSnapshots(
  mutate: (all: Record<string, AiQuotaSnapshot>) => void,
): Promise<void> {
  const run = mutationQueue.then(async () => {
    const current = await readAll();
    const next = { ...current };
    mutate(next);
    await writeAll(next);
  });
  // Keep the queue usable after a storage failure; each caller awaits its own
  // ordered attempt.
  mutationQueue = run.catch(() => undefined);
  await mutationQueue;
}

function isSameUtcDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export async function recordQuotaSnapshot(
  pageLabel: string,
  remainingRequestsToday: number | null,
): Promise<void> {
  if (!pageLabel) {
    return;
  }
  await mutateSnapshots((snapshots) => {
    snapshots[pageLabel] = {
      pageLabel,
      remainingRequestsToday,
      exhausted: remainingRequestsToday === 0,
      observedAt: Date.now(),
    };
  });
}

export async function recordQuotaDenied(pageLabel: string): Promise<void> {
  if (!pageLabel) {
    return;
  }
  await mutateSnapshots((snapshots) => {
    snapshots[pageLabel] = {
      pageLabel,
      remainingRequestsToday: 0,
      exhausted: true,
      observedAt: Date.now(),
    };
  });
}

/** Full per-page map, same-UTC-day only (a previous day's numbers would lie
 * after the kernel's 00:00 UTC reset). Empty object = no observations today. */
export async function getQuotaSnapshotsByPage(): Promise<Record<string, AiQuotaSnapshot>> {
  // Let any queued mutation land before reading, so a record that just resolved
  // is visible to the very next read.
  await mutationQueue;
  const snapshots = await readAll();
  const now = Date.now();
  const sameDay: Record<string, AiQuotaSnapshot> = {};
  for (const [pageLabel, snapshot] of Object.entries(snapshots)) {
    if (isSameUtcDay(snapshot.observedAt, now)) {
      sameDay[pageLabel] = snapshot;
    }
  }
  return sameDay;
}

/** Freshest same-UTC-day snapshot across pages (null when none). */
export async function getLatestQuotaSnapshot(): Promise<AiQuotaSnapshot | null> {
  await mutationQueue;
  const snapshots = await readAll();
  const now = Date.now();
  let latest: AiQuotaSnapshot | null = null;
  for (const snapshot of Object.values(snapshots)) {
    if (!isSameUtcDay(snapshot.observedAt, now)) {
      continue;
    }
    if (!latest || snapshot.observedAt > latest.observedAt) {
      latest = snapshot;
    }
  }
  return latest;
}
