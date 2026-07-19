import type { CoachHistoryEntry } from './types.js';

// Client-side replay projection — a MIRROR of core's prompt-builder projection
// (apps/runtime/.../prompts/builder.ts: COACH_ANSWER_PROJECTION_*). A committed
// coach answer may be up to the 64k transport ceiling, but before assembly core
// projects each replayed answer to a small head+tail so prompt cost never
// tracks the transport ceiling. The extension applies the SAME projection only
// as a bandwidth optimization: correctness NEVER depends on the client, because
// core re-projects each replayed answer authoritatively regardless of what the
// client sent.
//
// DRIFT IS NOT AUTO-CAUGHT. These constants MUST match core's, but no test pins
// them independently — the projection tests below derive their expectations from
// these same COACH_PROJECTION_* values, so a divergence from core's numbers
// would still pass green, and the template is not part of the vendored SDK. What
// keeps a drift harmless is the authoritative re-projection above; what keeps it
// from lasting is a MANUAL re-pin check against core's COACH_ANSWER_PROJECTION_*
// at each SDK re-vendor (mirroring the coach-draft fixture's honest-scope note).
export const COACH_PROJECTION_MAX_CHARS = 10_000;
export const COACH_PROJECTION_HEAD_CHARS = 6_000;
export const COACH_PROJECTION_TAIL_CHARS = 3_800;

/** A stored coach exchange awaiting projection: the answer is the RAW committed
 * text (un-projected), so a re-projection on the next turn stays stable. */
export interface CoachExchangeInput {
  question: string;
  answerRaw: string;
}

/** Code-point-safe head+tail slice with an explicit omission marker between the
 * two verbatim ends (never splits a surrogate pair). Matches core byte-for-byte
 * so a projected answer is identical on both sides of the wire. */
function sliceCoachAnswer(codePoints: string[], headChars: number, tailChars: number): string {
  const head = codePoints.slice(0, headChars).join('');
  const tail = codePoints.slice(codePoints.length - tailChars).join('');
  const omitted = codePoints.length - headChars - tailChars;
  return `${head}\n[… ${omitted} chars omitted …]\n${tail}`;
}

/** Projects a committed coach answer to ≤10k chars for prompt replay: the head
 * and tail verbatim with an explicit omission marker between them. Slicing is
 * code-point-safe (`Array.from`, never splits a surrogate pair). An answer
 * already within the cap is returned byte-identical (no-op), so a re-projected
 * answer is stable. head (6000) + tail (3800) + marker (≤27) ≤ 10_000. */
export function projectCoachAnswer(answer: string): string {
  const codePoints = Array.from(answer);
  if (codePoints.length <= COACH_PROJECTION_MAX_CHARS) {
    return answer;
  }
  return sliceCoachAnswer(
    codePoints,
    COACH_PROJECTION_HEAD_CHARS,
    COACH_PROJECTION_TAIL_CHARS,
  );
}

/** Takes the last `limit` completed exchanges (oldest-first, newest-inclusive)
 * and projects each answer for wire replay. A non-positive `limit` yields an
 * empty history; a `limit` beyond the count returns them all. */
export function serializeCoachHistory(
  exchanges: ReadonlyArray<CoachExchangeInput>,
  limit: number,
): CoachHistoryEntry[] {
  if (limit <= 0) {
    return [];
  }
  const start = Math.max(0, exchanges.length - limit);
  return exchanges.slice(start).map((exchange) => ({
    question: exchange.question,
    answer: projectCoachAnswer(exchange.answerRaw),
  }));
}
