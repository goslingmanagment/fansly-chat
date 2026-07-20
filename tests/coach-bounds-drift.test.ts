import { describe, expect, it } from 'vitest';
import { routeSchemas } from '@kernel/sdk';
import {
  COACH_ANSWER_MAX_CHARS,
  COACH_HISTORY_LIMIT_MAX,
  COACH_QUESTION_MAX_CHARS,
} from '../src/shared/constants.js';

// The extension mirrors three coach wire bounds locally (constants.ts) because
// the kernel SDK does NOT re-export them as named values — they live only inside
// the `aiFeatureStream.body` zod schema. If core moves a bound and we re-vendor
// the SDK without noticing, our local mirror silently drifts and the boundary
// validators clamp to the wrong ceiling. This suite pins each local constant to
// the ACTUAL bound in the vendored schema.
//
// We probe by safeParse rather than by introspecting `._def`: zod's internal
// shape has changed across major versions, but the parse contract (N chars pass,
// N+1 fail) is stable. Each pair proves the schema's bound is EXACTLY the local
// constant — a wider SDK bound lets N+1 through (fails the "rejects" case); a
// narrower one rejects N (fails the "accepts" case).

const bodySchema = routeSchemas.aiFeatureStream.body;

/** A minimal object that satisfies every OTHER required field, so the only
 * thing under test is the coach field we vary. */
function validBase(): Record<string, unknown> {
  return {
    clientRequestId: crypto.randomUUID(),
    pageLabel: 'x',
    platform: 'fansly',
    conversationRef: 'x',
  };
}

function accepts(patch: Record<string, unknown>): boolean {
  return bodySchema.safeParse({ ...validBase(), ...patch }).success;
}

describe('coach wire bounds mirror the vendored SDK schema', () => {
  it('sanity: the minimal base object is itself valid', () => {
    expect(bodySchema.safeParse(validBase()).success).toBe(true);
  });

  it('chatterQuestion max === COACH_QUESTION_MAX_CHARS', () => {
    expect(accepts({ chatterQuestion: 'a'.repeat(COACH_QUESTION_MAX_CHARS) })).toBe(true);
    expect(accepts({ chatterQuestion: 'a'.repeat(COACH_QUESTION_MAX_CHARS + 1) })).toBe(false);
  });

  it('coachHistory[].answer max === COACH_ANSWER_MAX_CHARS', () => {
    const entry = (answerLen: number) => ({
      coachHistory: [{ question: 'q', answer: 'a'.repeat(answerLen) }],
    });
    expect(accepts(entry(COACH_ANSWER_MAX_CHARS))).toBe(true);
    expect(accepts(entry(COACH_ANSWER_MAX_CHARS + 1))).toBe(false);
  });

  it('coachHistory[].question max === COACH_QUESTION_MAX_CHARS', () => {
    const entry = (questionLen: number) => ({
      coachHistory: [{ question: 'q'.repeat(questionLen), answer: 'a' }],
    });
    expect(accepts(entry(COACH_QUESTION_MAX_CHARS))).toBe(true);
    expect(accepts(entry(COACH_QUESTION_MAX_CHARS + 1))).toBe(false);
  });

  it('coachHistory array max === COACH_HISTORY_LIMIT_MAX', () => {
    const history = (count: number) => ({
      coachHistory: Array.from({ length: count }, () => ({ question: 'q', answer: 'a' })),
    });
    expect(accepts(history(COACH_HISTORY_LIMIT_MAX))).toBe(true);
    expect(accepts(history(COACH_HISTORY_LIMIT_MAX + 1))).toBe(false);
  });
});
