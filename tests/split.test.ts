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

  it('is case sensitive: [next] is NOT a separator', () => {
    expect(splitByNext('hello[next]world')).toEqual(['hello[next]world']);
  });

  it('handles [NEXT] with surrounding newlines', () => {
    expect(splitByNext('line one\n[NEXT]\nline two')).toEqual([
      'line one',
      'line two',
    ]);
  });
});
