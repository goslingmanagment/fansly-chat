// One UTC day of operational facts for the cabinet: hub-lane failures, the last
// accepted generation, the account→page bindings it revealed, and the last Fan
// Summary push. The «Статус» and «Agency Hub» panes read this instead of
// inventing activity from nothing.
//
// Custody: its OWN operational storage.local key with its OWN `version` field —
// never the settings blob (whose schema stays v15) and never a custody key.
// A malformed or foreign-version record is discarded rather than migrated: this
// is a day of counters, not user data.
//
// The day boundary is 00:00 UTC — the same boundary the kernel's AI quota resets
// at, which is what the popup already tells chatters.
//
// Every mutation goes through ONE module-level FIFO queue (the quota-tracker
// pattern): storage.local.set replaces the whole record, so two concurrent
// read-modify-writes would otherwise let the later writer erase the earlier
// one's counter.

import type { OpsDailySnapshot } from '../shared/types.js';

export type { OpsDailySnapshot };

const STORAGE_KEY = 'chatgoose:opsDaily';
/** Only kernel-hub failures are counted — the pane's label says «Hub». */
const HUB_ERROR_CODE_PREFIX = 'CG-HUB-';
/** The list is a tail for diagnostics; `hubErrorsTotal` stays exact. */
const HUB_ERROR_LIST_CAP = 20;

let memoryFallback: OpsDailySnapshot | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function localStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.local ?? null;
  } catch {
    return null;
  }
}

/** 'YYYY-MM-DD' in UTC. */
export function opsDailyDateUtc(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function emptySnapshot(dateUtc: string): OpsDailySnapshot {
  return {
    version: 1,
    dateUtc,
    hubErrors: [],
    hubErrorsTotal: 0,
    lastGeneration: null,
    pageByAccount: {},
    lastSummaryPush: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Accept only a well-formed v1 record for TODAY; anything else (foreign
 * version, garbage, yesterday) becomes a fresh day rather than a half-trusted
 * mixture. */
function normalize(raw: unknown, today: string): OpsDailySnapshot {
  if (!isRecord(raw) || raw.version !== 1 || raw.dateUtc !== today) {
    return emptySnapshot(today);
  }
  const hubErrors = Array.isArray(raw.hubErrors)
    ? raw.hubErrors.filter(
        (entry): entry is { code: string; at: number } =>
          isRecord(entry) &&
          typeof entry.code === 'string' &&
          typeof entry.at === 'number',
      )
    : [];
  const lastGeneration = isRecord(raw.lastGeneration) &&
    typeof raw.lastGeneration.at === 'number' &&
    typeof raw.lastGeneration.feature === 'string' &&
    typeof raw.lastGeneration.accountId === 'string' &&
    typeof raw.lastGeneration.accountLabel === 'string' &&
    typeof raw.lastGeneration.pageLabel === 'string'
    ? {
        at: raw.lastGeneration.at,
        feature: raw.lastGeneration.feature,
        accountId: raw.lastGeneration.accountId,
        accountLabel: raw.lastGeneration.accountLabel,
        pageLabel: raw.lastGeneration.pageLabel,
      }
    : null;
  const pageByAccount: Record<string, string> = {};
  if (isRecord(raw.pageByAccount)) {
    for (const [accountId, pageLabel] of Object.entries(raw.pageByAccount)) {
      if (typeof pageLabel === 'string') {
        pageByAccount[accountId] = pageLabel;
      }
    }
  }
  const lastSummaryPush = isRecord(raw.lastSummaryPush) &&
    typeof raw.lastSummaryPush.at === 'number' &&
    typeof raw.lastSummaryPush.accountLabel === 'string'
    ? { at: raw.lastSummaryPush.at, accountLabel: raw.lastSummaryPush.accountLabel }
    : null;
  return {
    version: 1,
    dateUtc: today,
    hubErrors: hubErrors.slice(-HUB_ERROR_LIST_CAP),
    hubErrorsTotal: typeof raw.hubErrorsTotal === 'number' && raw.hubErrorsTotal >= 0
      ? raw.hubErrorsTotal
      : hubErrors.length,
    lastGeneration,
    pageByAccount,
    lastSummaryPush,
  };
}

async function read(today: string): Promise<OpsDailySnapshot> {
  const area = localStorageArea();
  if (!area) {
    return memoryFallback && memoryFallback.dateUtc === today
      ? memoryFallback
      : emptySnapshot(today);
  }
  try {
    const raw = await area.get(STORAGE_KEY);
    return normalize(raw[STORAGE_KEY], today);
  } catch {
    return memoryFallback && memoryFallback.dateUtc === today
      ? memoryFallback
      : emptySnapshot(today);
  }
}

async function write(snapshot: OpsDailySnapshot): Promise<void> {
  memoryFallback = snapshot;
  const area = localStorageArea();
  if (!area) {
    return;
  }
  try {
    await area.set({ [STORAGE_KEY]: snapshot });
  } catch {
    // Counters are best-effort telemetry for a settings pane — a failed write is
    // never allowed to break the operation that recorded it. The memory copy
    // above does NOT rescue this update: `read` prefers the storage area
    // whenever `get` works, so an area that reads but fails to write keeps
    // serving the stale disk record and this increment is simply lost. The
    // memory copy only covers an area that is absent or failing on read too.
  }
}

/** Serialize a read-modify-write of the whole record. Each queued task re-reads
 * the freshest snapshot (and re-derives the UTC day) before applying its own
 * change, so overlapping recorders compose instead of clobbering. */
async function mutate(
  apply: (snapshot: OpsDailySnapshot, now: number) => void,
): Promise<void> {
  const run = mutationQueue.then(async () => {
    const now = Date.now();
    const snapshot = await read(opsDailyDateUtc(now));
    apply(snapshot, now);
    await write(snapshot);
  });
  // Keep the queue usable after a storage failure; each caller awaits its own
  // ordered attempt.
  mutationQueue = run.catch(() => undefined);
  await mutationQueue;
}

/** Count ONE hub-lane failure. Codes outside the `CG-HUB-` family are ignored:
 * the pane names the Hub, so a Fansly or flow error must never inflate it. */
export async function recordHubError(code: string): Promise<void> {
  if (!code.startsWith(HUB_ERROR_CODE_PREFIX)) {
    return;
  }
  await mutate((snapshot, now) => {
    snapshot.hubErrors.push({ code, at: now });
    if (snapshot.hubErrors.length > HUB_ERROR_LIST_CAP) {
      snapshot.hubErrors = snapshot.hubErrors.slice(-HUB_ERROR_LIST_CAP);
    }
    snapshot.hubErrorsTotal += 1;
  });
}

/** Record a generation the coordinator ACCEPTED (a delivered result), together
 * with the account→page binding it just proved. */
export async function recordGeneration(event: {
  feature: string;
  accountId: string;
  accountLabel: string;
  pageLabel: string;
}): Promise<void> {
  await mutate((snapshot, now) => {
    snapshot.lastGeneration = { at: now, ...event };
    if (event.accountId && event.pageLabel) {
      snapshot.pageByAccount[event.accountId] = event.pageLabel;
    }
  });
}

export async function recordSummaryPush(accountLabel: string): Promise<void> {
  await mutate((snapshot, now) => {
    snapshot.lastSummaryPush = { at: now, accountLabel };
  });
}

/** Today's snapshot. A stored record from a previous UTC day reads as an empty
 * day — «сегодня генераций не было» must never be a yesterday number. */
export async function getOpsDaily(): Promise<OpsDailySnapshot> {
  // Let any queued mutation land first, so a record that just resolved is
  // visible to the very next read.
  await mutationQueue;
  return read(opsDailyDateUtc(Date.now()));
}

/** Test seam: drop the in-memory copy so a fresh case starts clean. */
export function resetOpsDailyMemory(): void {
  memoryFallback = null;
}
