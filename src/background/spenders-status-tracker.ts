// Spenders board status tracker. The board cache is source-scoped and deleted
// on disabled states, so it cannot answer "what did the board last show". This
// keeps ONE freshest observation per source identity so the options Статус row
// can render RAMPED/FLAG OFF/NOT ALLOWLISTED/FAIL without ever performing a
// Fansly request (options has no tab). Custody: storage.session (survives
// event-page restarts, dies with the browser session, never syncs), memory
// fallback for unit tests — the same pattern as quota-tracker.

import type { SpendersObservation } from '../shared/types.js';

const STORAGE_KEY = 'spendersObservations';

let memoryFallback: Record<string, SpendersObservation> = {};

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

export async function recordSpendersObservation(
  observation: Omit<SpendersObservation, 'observedAt'>,
): Promise<void> {
  if (!observation.sourceIdentity) return;
  const all = await readAll();
  all[observation.sourceIdentity] = { ...observation, observedAt: Date.now() };
  await writeAll(all);
}

/** Freshest observation across sources (null when none). Chatters run one
 * creator per browser session, so freshest is the board the row means. */
export async function getLatestSpendersObservation(): Promise<SpendersObservation | null> {
  const all = await readAll();
  let latest: SpendersObservation | null = null;
  for (const observation of Object.values(all)) {
    if (!latest || observation.observedAt > latest.observedAt) latest = observation;
  }
  return latest;
}
