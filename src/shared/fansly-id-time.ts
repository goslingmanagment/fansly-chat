// Fansly ids are snowflakes: the bits above the low 22 are the milliseconds
// since Fansly's own epoch, so an id alone says when the thing it names was
// created — an account id is the registration time, a follow relation id the
// moment of the follow. Checked against the `createdAt` Fansly serves for
// accounts: the two agree to the second.

const FANSLY_EPOCH_MS = 1561494360000;

/** The creation time an id carries, or null when the value is not a Fansly id
 * (not numeric, before the epoch, or from the future). */
export function fanslyIdTimestampMs(value: string, now = Date.now()): number | null {
  if (!/^\d{1,24}$/.test(value)) return null;
  const ms = Number(BigInt(value) >> 22n) + FANSLY_EPOCH_MS;
  return Number.isSafeInteger(ms) && ms > FANSLY_EPOCH_MS && ms <= now + 60_000 ? ms : null;
}
