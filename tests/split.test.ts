import { describe, it, expect } from 'vitest';
import { splitByNext } from '../src/shared/split.js';

describe('splitByNext', () => {
  it('returns a single-element array when no [NEXT] is present', () => {
    expect(splitByNext('hello world')).toEqual(['hello world']);
  });

  it('splits into two parts on [NEXT]', () => {
    expect(splitByNext('hello[NEXT]world')).toEqual(['hello', 'world']);
  });

  it('splits into three parts on multiple [NEXT]', () => {
    expect(splitByNext('a[NEXT]b[NEXT]c')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty first part when [NEXT] is at start', () => {
    expect(splitByNext('[NEXT]hello')).toEqual(['hello']);
  });

  it('filters empty last part when [NEXT] is at end', () => {
    expect(splitByNext('hello[NEXT]')).toEqual(['hello']);
  });

  it('trims whitespace around [NEXT] delimiters', () => {
    expect(splitByNext('hello  [NEXT]  world')).toEqual(['hello', 'world']);
  });

  it('filters empty parts when multiple [NEXT] appear in a row', () => {
    expect(splitByNext('a[NEXT][NEXT][NEXT]b')).toEqual(['a', 'b']);
  });

  it('returns empty array when input is just [NEXT]', () => {
    expect(splitByNext('[NEXT]')).toEqual([]);
  });

  it('preserves content and trims when no [NEXT] with whitespace', () => {
    expect(splitByNext('  hello world  ')).toEqual(['hello world']);
  });

  // The old "case sensitive: [next] is NOT a separator" pin was reversed in
  // E24: real model output drifts in case/whitespace, and a literal split
  // silently glued a requested split back into one message. The tolerance
  // suite below pins the new behavior (bracket forms only).

  it('handles [NEXT] with surrounding newlines', () => {
    expect(splitByNext('line one\n[NEXT]\nline two')).toEqual([
      'line one',
      'line two',
    ]);
  });
});

// ── E24: marker drift tolerance ─────────────────────────────────────────────

describe('splitByNext marker tolerance', () => {
  it('splits on lowercase and mixed-case markers', () => {
    expect(splitByNext('hello[next]world')).toEqual(['hello', 'world']);
    expect(splitByNext('hello[Next]world')).toEqual(['hello', 'world']);
  });

  it('splits on markers with inner whitespace', () => {
    expect(splitByNext('hello[ NEXT ]world')).toEqual(['hello', 'world']);
    expect(splitByNext('hello[  next]world')).toEqual(['hello', 'world']);
  });

  it('never splits on a bare NEXT in prose', () => {
    expect(splitByNext('see you NEXT week')).toEqual(['see you NEXT week']);
    expect(splitByNext('the next one')).toEqual(['the next one']);
  });
});
