import { describe, expect, it } from 'vitest';
import {
  COACH_PROJECTION_HEAD_CHARS,
  COACH_PROJECTION_MAX_CHARS,
  COACH_PROJECTION_TAIL_CHARS,
  projectCoachAnswer,
  serializeCoachHistory,
} from '../src/shared/coach-history.js';

describe('projectCoachAnswer', () => {
  it('returns answers at or under the cap unchanged (no-op ≤10k)', () => {
    const atCap = 'a'.repeat(COACH_PROJECTION_MAX_CHARS);
    expect(projectCoachAnswer(atCap)).toBe(atCap);
    const shorter = 'hello coach';
    expect(projectCoachAnswer(shorter)).toBe(shorter);
    expect(projectCoachAnswer('')).toBe('');
  });

  it('projects an oversized answer to head + omission marker + tail', () => {
    const head = 'H'.repeat(COACH_PROJECTION_HEAD_CHARS);
    const middle = 'M'.repeat(5_000);
    const tail = 'T'.repeat(COACH_PROJECTION_TAIL_CHARS);
    const answer = head + middle + tail;
    const projected = projectCoachAnswer(answer);
    const omitted =
      Array.from(answer).length - COACH_PROJECTION_HEAD_CHARS - COACH_PROJECTION_TAIL_CHARS;
    expect(projected).toBe(`${head}\n[… ${omitted} chars omitted …]\n${tail}`);
    expect(projected.startsWith(head)).toBe(true);
    expect(projected.endsWith(tail)).toBe(true);
    expect(projected).toContain(`${omitted} chars omitted`);
    expect(omitted).toBe(5_000);
  });

  it('slices on code points, never splitting a surrogate pair', () => {
    // Each emoji is 2 UTF-16 code units; a naive .slice would count code units,
    // Array.from counts code points. Build > cap code points of pure emoji.
    const emoji = '😀';
    const answer = emoji.repeat(COACH_PROJECTION_MAX_CHARS + 100);
    const projected = projectCoachAnswer(answer);
    // Head is exactly HEAD_CHARS *code points* of emoji (proves code-point count
    // AND that no pair was split — a split would leave a lone surrogate).
    expect(projected.startsWith(emoji.repeat(COACH_PROJECTION_HEAD_CHARS))).toBe(true);
    expect(projected.endsWith(emoji.repeat(COACH_PROJECTION_TAIL_CHARS))).toBe(true);
    // No lone surrogate survives a round-trip through Array.from.
    for (const cp of Array.from(projected)) {
      const code = cp.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });
});

describe('serializeCoachHistory', () => {
  it('keeps only the last `limit` exchanges, oldest-first, newest-inclusive', () => {
    const exchanges = [
      { question: 'q1', answerRaw: 'a1' },
      { question: 'q2', answerRaw: 'a2' },
      { question: 'q3', answerRaw: 'a3' },
    ];
    expect(serializeCoachHistory(exchanges, 2)).toEqual([
      { question: 'q2', answer: 'a2' },
      { question: 'q3', answer: 'a3' },
    ]);
  });

  it('projects each replayed answer through projectCoachAnswer', () => {
    const long = 'z'.repeat(COACH_PROJECTION_MAX_CHARS + 1);
    const [entry] = serializeCoachHistory([{ question: 'q', answerRaw: long }], 5);
    expect(entry?.answer).toBe(projectCoachAnswer(long));
    expect((entry?.answer.length ?? 0)).toBeLessThan(long.length);
  });

  it('returns an empty array for a non-positive limit', () => {
    expect(serializeCoachHistory([{ question: 'q', answerRaw: 'a' }], 0)).toEqual([]);
    expect(serializeCoachHistory([{ question: 'q', answerRaw: 'a' }], -3)).toEqual([]);
  });

  it('returns every exchange when the limit exceeds the count', () => {
    const exchanges = [{ question: 'q', answerRaw: 'a' }];
    expect(serializeCoachHistory(exchanges, 20)).toEqual([{ question: 'q', answer: 'a' }]);
  });

  it('returns an empty array for an empty input', () => {
    expect(serializeCoachHistory([], 10)).toEqual([]);
  });
});
