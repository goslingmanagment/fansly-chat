// Spenders board status tracker. The board cache is source-scoped and deleted
// on disabled states, so it cannot answer "what did the board last show". This
// keeps ONE freshest observation per source identity so the options Статус row
// can render RAMPED/FLAG OFF/NOT ALLOWLISTED/FAIL without ever performing a
// Fansly request (options has no tab). Custody: storage.session (survives
// event-page restarts, dies with the browser session, never syncs), memory
// fallback for unit tests — the same pattern as quota-tracker.

import { sha256Hex } from '../shared/sha256.js';
import type { SpendersObservation } from '../shared/types.js';

const STORAGE_KEY = 'spendersObservations';

let memoryFallback: Record<string, SpendersObservation> = {};

// storage.session updates replace the whole per-source object. Serialize every
// read-modify-write so two overlapping board builds (different creators) cannot
// both read the same snapshot and let the later writer erase the earlier
// creator's observation. Mirrors quota-tracker's mutation queue.
let mutationQueue: Promise<void> = Promise.resolve();

/** The hub+credential scope suffix an observation's sourceIdentity ends with.
 * Binding the observation to a bearer fingerprint (not the hub URL alone) means
 * a same-URL credential swap cannot surface the previous principal's board. The
 * bearer is hashed — the raw device token / key never lands in a status key. */
export function spendersObservationScope(hubBaseUrl: string, bearer: string): string {
  return `${hubBaseUrl}|${sha256Hex(bearer)}`;
}

function sessionStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function readAll(): Promise<Record<string, SpendersObservation>> {
  const area = sessionStorageArea();
  if (!area) return memoryFallback;
  try {
    const raw = await area.get(STORAGE_KEY);
    const value = raw[STORAGE_KEY];
    return value && typeof value === 'object'
      ? (value as Record<string, SpendersObservation>)
      : {};
  } catch {
    return memoryFallback;
  }
}

async function writeAll(observations: Record<string, SpendersObservation>): Promise<void> {
  memoryFallback = observations;
  const area = sessionStorageArea();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEY]: observations });
  } catch {
    // Memory fallback already holds the data; session storage is best-effort.
  }
}

/** Serialize a read-modify-write of the whole per-source map. Each queued task
 * re-reads the freshest snapshot before applying its own change, so overlapping
 * builds compose instead of clobbering. */
async function mutateObservations(
  mutate: (all: Record<string, SpendersObservation>) => void,
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

export async function recordSpendersObservation(
  observation: Omit<SpendersObservation, 'observedAt'>,
): Promise<void> {
  if (!observation.sourceIdentity) return;
  await mutateObservations((all) => {
    all[observation.sourceIdentity] = { ...observation, observedAt: Date.now() };
  });
}

/** Drop every recorded observation. The background clears these when the hub
 * source (base URL or credential) changes, alongside the board cache: a board
 * observed under the previous principal must not survive a credential swap. */
export async function clearSpendersObservations(): Promise<void> {
  await mutateObservations((all) => {
    for (const key of Object.keys(all)) delete all[key];
  });
}

/** Freshest observation recorded under the CURRENT hub AND credential (null when
 * none). The caller passes the normalized hub base URL and the raw bearer; every
 * recorded `sourceIdentity` is `creator|hubBaseUrl|sha256(bearer)`, and only
 * entries ending in the current `|hubBaseUrl|sha256(bearer)` are eligible — so an
 * observation captured under a previous hub OR a previous credential (same URL)
 * is invisible. Chatters run one creator per browser session, so the freshest
 * eligible entry is the board the row means. */
export async function getLatestSpendersObservation(
  currentHubBaseUrl: string | null,
  currentBearer: string | null,
): Promise<SpendersObservation | null> {
  if (!currentHubBaseUrl || !currentBearer) return null;
  // Let any queued mutation land first, so an observation that just resolved is
  // visible to the very next read.
  await mutationQueue;
  const suffix = `|${spendersObservationScope(currentHubBaseUrl, currentBearer)}`;
  const all = await readAll();
  let latest: SpendersObservation | null = null;
  for (const observation of Object.values(all)) {
    if (!observation.sourceIdentity.endsWith(suffix)) continue;
    if (!latest || observation.observedAt > latest.observedAt) latest = observation;
  }
  return latest;
}
