import type { PacePolicy } from './policy.js';

/** One pace key's learned spacing. Pure data and pure transitions: no timers,
 * no IO, so every rule below is testable on its own (E130). */
export interface RouteState {
  spacingMs: number;
  /** Answered reads that exercised `spacingMs` since it last changed. */
  clean: number;
  lastStartAt: number;
  /** The spacing Fansly last limited this key at, and when. */
  badMs: number;
  badAt: number;
  /** Answered reads count only from here: the cooldown's end plus the quiet period. */
  quietUntil: number;
}

/** A step toward the floor needs this many answered reads at the current spacing. */
export const STEP_READS = 40;
const STEP = 0.9;
/** A limited spacing is remembered this long, and the key stays this far above it. */
export const BAD_MEMORY_MS = 24 * 3600_000;
const BAD_MARGIN = 1.25;
/** Same quiet period as the lane penalty (E128): reads right after a cooldown prove nothing. */
export const QUIET_MS = 300_000;
/** A read exercised the spacing only if it started this close to the previous one. */
const EXERCISED = 1.25;

export const fresh = (policy: PacePolicy): RouteState => ({ spacingMs: policy.startMs, clean: 0, lastStartAt: 0, badMs: 0, badAt: 0, quietUntil: 0 });

/** Lowest spacing allowed now: the policy floor, or a margin above a remembered limit. */
export function floorOf(state: RouteState, policy: PacePolicy, now: number): number {
  const remembered = state.badMs > 0 && now - state.badAt < BAD_MEMORY_MS;
  return remembered ? Math.min(policy.ceilMs, Math.max(policy.floorMs, Math.ceil(state.badMs * BAD_MARGIN))) : policy.floorMs;
}

/** Sparse reads say nothing about a pace they never ran at, so only a read that
 * followed the previous one closely counts toward a faster step. */
export function started(state: RouteState, now: number): { state: RouteState; exercised: boolean } {
  const exercised = state.lastStartAt > 0 && now - state.lastStartAt <= state.spacingMs * EXERCISED;
  return { state: { ...state, lastStartAt: now }, exercised };
}

export function served(state: RouteState, policy: PacePolicy, now: number, exercised: boolean): RouteState {
  if (!exercised || now < state.quietUntil) return state;
  if (state.clean + 1 < STEP_READS) return { ...state, clean: state.clean + 1 };
  return { ...state, clean: 0, spacingMs: Math.max(floorOf(state, policy, now), Math.min(state.spacingMs, Math.round(state.spacingMs * STEP))) };
}

export function limited(state: RouteState, policy: PacePolicy, now: number, cooldownUntil: number): RouteState {
  return { ...state, clean: 0, badMs: state.spacingMs, badAt: now, quietUntil: cooldownUntil + QUIET_MS, spacingMs: Math.min(policy.ceilMs, state.spacingMs * 2) };
}

/** After a truly idle lane the key starts over, but never below a remembered limit:
 * a faster pace is proved again each session, a limit is not forgotten by waiting. */
export function rested(state: RouteState, policy: PacePolicy, now: number): RouteState {
  return { ...state, clean: 0, lastStartAt: 0, spacingMs: Math.max(policy.startMs, floorOf(state, policy, now)) };
}
