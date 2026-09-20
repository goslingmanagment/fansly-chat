/** Pacing policy is data. A route family is paced on its own key, so a limit
 * on one family never slows another, and a new family or a different pace is
 * one row here rather than a scheduler change (E130). */
export interface PacePolicy {
  /** Spacing between starts on this key before anything is learned. */
  startMs: number;
  /** Lowest spacing the key may reach. Equal to `startMs` = never accelerates. */
  floorMs: number;
  /** Spacing never grows past this, however often the key is limited. */
  ceilMs: number;
}

export const LANE_GAP_MS = 400;
export const LANE_GAP_MAX_MS = 8000;
/** Uniform 0..JITTER added to every lane gap: no metronome signature. */
export const LANE_JITTER_MS = 100;

/** FBuddy starts every route at 400 ms and only speeds up from there. Here
 * 400 ms is the floor of a key and also the gap of the whole creator lane. */
const DEFAULT_POLICY: PacePolicy = { startMs: 500, floorMs: 400, ceilMs: 8000 };

/** Families group paths that evidence says share a limit. `/account*` is a
 * live measurement (E128): the only 429 was the third `/account?ids=` read 2 s
 * apart and also the fifth `/account*` read in 10 s. One trace cannot tell
 * those apart, so follower pages share the key with the id reads. */
const FAMILIES: ReadonlyArray<{ key: string; match: RegExp; policy: PacePolicy }> = [
  { key: 'GET /account*', match: /^\/api\/v1\/account(?:\/|$)/, policy: { startMs: 5000, floorMs: 5000, ceilMs: 20_000 } },
];

/** A saved key outlives the code that wrote it; an unknown one gets the default. */
export const policyOf = (key: string): PacePolicy => FAMILIES.find((entry) => entry.key === key)?.policy ?? DEFAULT_POLICY;

export function paceFor(method: string, pathname: string): { key: string; policy: PacePolicy } {
  const family = FAMILIES.find((entry) => entry.match.test(pathname));
  if (family) return { key: family.key, policy: family.policy };
  const path = pathname.replace(/^\/api\/v\d+/, '').split('/').map((part) => (/^\d+$/.test(part) ? ':id' : part)).join('/');
  return { key: `${method.toUpperCase()} ${path}`, policy: DEFAULT_POLICY };
}
