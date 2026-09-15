// The custody of the one hub credential this extension holds, and the two
// rules that protect it (E79 / plan §4.5).
//
// 1. ONE FIFO. Every mutation of the stored sign-in — issue, wipe, self-heal —
//    runs inside the same promise queue. Without it a sign-in landing mid
//    sign-out interleaves: the fresh bearer is stored, the sign-out's wipe
//    erases it, and its revoke kills a DIFFERENT captured bearer, leaving a
//    live one orphaned on the hub with nothing left here to revoke it with.
// 2. A WIPE MUST PROVE ITSELF. A 401 only clears this device when the server
//    named a reason it can act on AND the rejected bearer is still the stored
//    one. A bare 401 fails closed — an outage, a misrouted request or a
//    half-deployed core must never sign the chatter out.

import type { KernelApiError } from '@kernel/sdk';

import {
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY,
} from '../shared/constants.js';
import { logWarn } from '../shared/log.js';
import { sha256Hex } from '../shared/sha256.js';

let agencyHubCustodyQueue: Promise<unknown> = Promise.resolve();

/** Serialize one custody mutation against every other. */
export function withAgencyHubCustodyLock<T>(critical: () => Promise<T>): Promise<T> {
  // Chain onto the tail regardless of how the previous holder settled, so one
  // rejection never poisons the queue for the next waiter.
  const run = agencyHubCustodyQueue.then(critical, critical);
  agencyHubCustodyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Erase this device's sign-in. The live slot goes to an EMPTY STRING (the
 * settings blob never carries it, and a removal would make the layout repair
 * think the custody key is missing); the retired legacy slot is REMOVED, since
 * v17 took its fallback read out of the build with it.
 *
 * Callers own the FIFO — this function does not take the lock itself, so a
 * caller that also captures a bearer to revoke sees a consistent pair.
 */
export async function wipeHubCustody(): Promise<void> {
  await browser.storage.local.set({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '' });
  try {
    await browser.storage.local.remove(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY);
  } catch (error) {
    // Best effort by design: the live slot above is what a request would read,
    // and nothing in this build reads the retired slot at all.
    logWarn('Legacy hub credential slot removal failed', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
  }
}

/** The two 401 reasons this client is allowed to act on by itself. */
export const SELF_HEALING_UNAUTHORIZED_REASONS = ['token_revoked', 'token_expired'] as const;
export type SelfHealingUnauthorizedReason = typeof SELF_HEALING_UNAUTHORIZED_REASONS[number];

/**
 * Read the server's structural `reason` off a 401/403 and return it only when
 * it is one this client may self-heal. Everything else — including a 401 with
 * no reason at all — answers null, which is the fail-closed path.
 */
export function selfHealingUnauthorizedReason(
  error: Pick<KernelApiError, 'status' | 'body'>,
): SelfHealingUnauthorizedReason | null {
  if (error.status !== 401 && error.status !== 403) {
    return null;
  }
  if (!error.body || typeof error.body !== 'object') {
    return null;
  }
  const reason = (error.body as Record<string, unknown>).reason;
  return (SELF_HEALING_UNAUTHORIZED_REASONS as readonly string[]).includes(reason as string)
    ? (reason as SelfHealingUnauthorizedReason)
    : null;
}

/**
 * Clear the sign-in that a named 401 just invalidated — but only if the bearer
 * that was rejected is still the one on disk. The comparison runs on sha-256
 * digests so no second copy of the credential is held for it, and the whole
 * check + wipe runs inside the FIFO so a sign-in that landed a millisecond
 * earlier cannot be thrown away by a rejection that belonged to its
 * predecessor.
 *
 * Returns whether this device was actually signed out.
 */
export async function healRevokedHubSession(rejectedBearer: string): Promise<boolean> {
  const rejected = (rejectedBearer ?? '').trim();
  if (!rejected) {
    return false;
  }
  const rejectedDigest = sha256Hex(rejected);
  return withAgencyHubCustodyLock(async () => {
    try {
      const raw = await browser.storage.local.get(AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY);
      const stored = raw[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY];
      const storedToken = typeof stored === 'string' ? stored.trim() : '';
      if (!storedToken || sha256Hex(storedToken) !== rejectedDigest) {
        // Someone signed in again between the request and its answer (or this
        // device was already signed out). Not ours to erase.
        return false;
      }
      await wipeHubCustody();
      await browser.storage.local
        .remove(AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY)
        .catch(() => undefined);
      return true;
    } catch (error) {
      logWarn('Hub session self-heal failed', {
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      return false;
    }
  });
}

/** `Firefox · Windows` (Р7). One short, human device name — never a build
 * string, and never anything about the credential. */
export function buildDeviceLabel(userAgent: string): string {
  const ua = userAgent ?? '';
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /Linux|X11/i.test(ua)
          ? 'Linux'
          : null;
  return os ? `Firefox · ${os}` : 'Firefox';
}
