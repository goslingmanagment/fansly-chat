import { FANSLY_CUSTOM_NAME_NOTE_TYPE } from './constants.js';
import type { FanslyAccountResponse } from './types.js';

/** The creator's custom display name for a fan: Fansly's native rename, stored
 * as a creator-visible account note whose text IS the name (contentType 12002,
 * E25). CRM blobs (12000) never match. */
export function customNameFromAccount(account: FanslyAccountResponse): string | null {
  if (!Array.isArray(account.notes)) return null;
  const note = account.notes.find(
    (entry) => entry?.contentType === FANSLY_CUSTOM_NAME_NOTE_TYPE,
  );
  const text = note?.note?.trim();
  return text ? text : null;
}

/** Kernel contract bound for `clientContext.fanCustomName` (Core Decision 290). */
export const KERNEL_FAN_CUSTOM_NAME_MAX_CHARS = 200;

/** The chatter-saved name as the kernel accepts it (E115): trimmed, bounded to
 * the contract max on code points (never a split surrogate), undefined when
 * the fan was never renamed or the lookup returned nothing. The kernel prompt
 * owns the "name part only" rule for tag-like labels; the client sends the
 * label as saved. */
export function kernelFanCustomName(
  account: FanslyAccountResponse | undefined,
): string | undefined {
  const name = account ? customNameFromAccount(account) : null;
  if (!name) return undefined;
  const points = Array.from(name);
  return points.length > KERNEL_FAN_CUSTOM_NAME_MAX_CHARS
    ? points.slice(0, KERNEL_FAN_CUSTOM_NAME_MAX_CHARS).join('')
    : name;
}
