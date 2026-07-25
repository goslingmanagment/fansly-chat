// Local, chatter-owned nicknames for Fansly accounts («Лора-1», «утренняя»).
//
// They exist because an 18-digit account id and a model's public display name
// are both poor row labels for someone juggling six accounts. They are LOCAL by
// contract: nothing ever sends them to the kernel or to Fansly, and they are not
// part of the account identity the rest of the extension reasons about.
//
// Custody: its OWN operational storage.local key with its OWN `version` field.
// The settings blob stays v15 — a label is not a setting, so no migration ships
// with this feature (a dropped v16 is a decision, not an oversight).
//
// The ONLY writer is the `setAccountLabel` runtime operation: the options page
// never writes this key itself, so there is exactly one serialized path into it
// (the module-level FIFO queue below) no matter how many settings tabs are open.

import type { AccountLabelsSnapshot } from '../shared/types.js';

export type { AccountLabelsSnapshot };

const STORAGE_KEY = 'chatgoose:accountLabels';
/** A row label, not a note: long enough for «Лора · утренняя смена», short
 * enough that the pane can never be blown out by a paste. */
const LABEL_MAX_LENGTH = 60;

let memoryFallback: AccountLabelsSnapshot | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

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

function emptySnapshot(): AccountLabelsSnapshot {
  return { version: 1, byAccount: {} };
}

/** Accept only a well-formed v1 record; anything else becomes an empty one. */
function normalize(raw: unknown): AccountLabelsSnapshot {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.byAccount)) {
    return emptySnapshot();
  }
  const byAccount: Record<string, string> = {};
  for (const [accountId, label] of Object.entries(raw.byAccount)) {
    if (!accountId || typeof label !== 'string') {
      continue;
    }
    const normalized = normalizeLabel(label);
    if (normalized) {
      byAccount[accountId] = normalized;
    }
  }
  return { version: 1, byAccount };
}

/** Trim, collapse newlines, cap length. An empty result means «no label». */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LENGTH);
}

async function read(): Promise<AccountLabelsSnapshot> {
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

async function write(snapshot: AccountLabelsSnapshot): Promise<void> {
  memoryFallback = snapshot;
  const area = localStorageArea();
  if (!area) {
    return;
  }
  await area.set({ [STORAGE_KEY]: snapshot });
}

/** Serialize a read-modify-write of the whole record: storage.local.set replaces
 * it, so two chatters' rapid renames (or a rename racing a rekey transfer) would
 * otherwise let the later writer erase the earlier label. */
async function mutate(apply: (snapshot: AccountLabelsSnapshot) => void): Promise<void> {
  const run = mutationQueue.then(async () => {
    const snapshot = await read();
    apply(snapshot);
    await write(snapshot);
  });
  // Keep the queue usable after a failure; each caller awaits its own attempt.
  mutationQueue = run.catch(() => undefined);
  await run;
}

/**
 * Write (or clear) one account's local label. Unlike presence, this is a
 * deliberate chatter action, so a storage failure REJECTS: the pane has to be
 * able to say the rename did not stick instead of silently reverting on reload.
 */
export async function setAccountLabel(accountId: string, label: string): Promise<void> {
  const id = accountId?.trim();
  if (!id) {
    return;
  }
  const normalized = normalizeLabel(label ?? '');
  await mutate((snapshot) => {
    if (normalized) {
      snapshot.byAccount[id] = normalized;
    } else {
      // An emptied field is «remove the label», never a stored empty string.
      delete snapshot.byAccount[id];
    }
  });
}

/**
 * Move a legacy account's label onto the canonical id. The CANONICAL label wins
 * on conflict and the legacy entry is removed — the chatter's most recent
 * naming of the id every other store uses is the one that survives.
 */
export async function transferAccountLabel(
  legacyAccountId: string,
  canonicalAccountId: string,
): Promise<void> {
  if (!legacyAccountId || !canonicalAccountId || legacyAccountId === canonicalAccountId) {
    return;
  }
  await mutate((snapshot) => {
    const legacy = snapshot.byAccount[legacyAccountId];
    if (legacy === undefined) {
      return;
    }
    delete snapshot.byAccount[legacyAccountId];
    if (snapshot.byAccount[canonicalAccountId] === undefined) {
      snapshot.byAccount[canonicalAccountId] = legacy;
    }
  });
}

export async function getAccountLabels(): Promise<AccountLabelsSnapshot> {
  // Let any queued mutation land first, so a rename that just resolved is
  // visible to the very next read.
  await mutationQueue;
  return read();
}

/** Test seam: drop the in-memory copy so a fresh case starts clean. */
export function resetAccountLabelsMemory(): void {
  memoryFallback = null;
}
